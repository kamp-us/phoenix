/**
 * Per-term Agent DO. Addressed by `idFromName(slug)` — one instance per term.
 *
 * Lineage:
 * - ADR 0005 — per-coordination-atom sharding (`SozlukTerm` per term).
 * - ADR 0006 — extends `Agent<Env, TermState>`; typed state + WebSocket sync
 *   + named schedules.
 * - ADR 0007 — outbox + Workflows + D1 view layer; mutation methods land in
 *   later tasks (T4–T6) with the producer pattern (atomic outbox + `this.queue`
 *   + `onStart` reconciliation).
 *
 * T2 scope: read paths + admin seed paths. The mutation surface
 * (`addDefinition`, `voteDefinition`, …) lands in T4+. The outbox table and
 * reconciliation skeletons exist now so T4 can wire mutations without another
 * schema migration.
 */
import {id} from "@usirin/forge";
import {Agent} from "agents";
import {and, asc, desc, eq, isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./term-drizzle/migrations/migrations";
import * as schema from "./term-drizzle/schema";

/* -------------------------------------------------------------------------- */
/* State + read shapes                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Canonical aggregates kept on `Agent.state`. Mutation methods recompute
 * and `setState({...})` after each `transactionSync`. The values here are
 * the only thing WebSocket-connected clients see live; they MUST always
 * reflect the underlying sqlite truth.
 *
 * `lastEventId` is set on every state-changing mutation; it's the convergence
 * guard column for `term_summary` in `PHOENIX_DB`.
 */
export interface TermState {
	title: string;
	definitionCount: number;
	totalScore: number;
	lastActivityAt: number;
	lastEventId: string;
}

const INITIAL_STATE: TermState = {
	title: "",
	definitionCount: 0,
	totalScore: 0,
	lastActivityAt: 0,
	lastEventId: "",
};

/**
 * Read shape returned by `getTerm()`. Keeps the GraphQL `Term` type a
 * dumb projection — all the fields the existing `SozlukTermPage` query
 * asks for show up here directly. Dates are JS `Date` for ergonomic
 * downstream usage; the resolver layer converts to ISO strings.
 */
export interface DefinitionRow {
	id: string;
	score: number;
	body: string;
	author: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface TermPage {
	id: string;
	slug: string;
	title: string;
	totalDefinitions: number;
	totalScore: number;
	firstAt: Date;
	lastEdit: Date;
	definitions: DefinitionRow[];
}

/* -------------------------------------------------------------------------- */
/* Admin / seed shapes                                                         */
/* -------------------------------------------------------------------------- */

export interface SeedDefinitionInput {
	authorId: string;
	authorName: string;
	body: string;
	score?: number | undefined;
}

export interface SeedTermInput {
	title: string;
	definitions: SeedDefinitionInput[];
}

export interface SeedTermResult {
	insertedDefinitions: number;
	skippedDefinitions: number;
	created: boolean;
}

/* -------------------------------------------------------------------------- */
/* Mutation shapes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Validation error thrown by mutation methods. The GraphQL resolver catches
 * this and surfaces a `code` extension so the SPA can localize.
 */
export class DefinitionValidationError extends Error {
	constructor(
		readonly code: "body_required" | "body_too_long",
		message: string,
	) {
		super(message);
		this.name = "DefinitionValidationError";
	}
}

/** Result returned to the resolver after `addDefinition` writes commit. */
export interface AddDefinitionResult {
	definitionId: string;
	termCreated: boolean;
	score: number;
	body: string;
	authorId: string;
	authorName: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface AddDefinitionInput {
	authorId: string;
	authorName: string;
	body: string;
	/** Optional human title. Falls back to slug-with-spaces. */
	termTitle?: string | undefined;
}

/** Body length cap — surfaced as `body_too_long` to the resolver. */
export const DEFINITION_BODY_MAX = 10_000;

/* -------------------------------------------------------------------------- */
/* Agent                                                                       */
/* -------------------------------------------------------------------------- */

export class SozlukTerm extends Agent<Env, TermState> {
	override initialState: TermState = INITIAL_STATE;

	db = drizzle(this.ctx.storage, {schema});

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	/* -------- Lifecycle -------------------------------------------------- */

	/**
	 * Periodic outbox reconciliation (5 min) per ADR 0007. Plus a one-shot
	 * reconcile on hydration so any rows left over from a worker that died
	 * mid-flush get re-dispatched immediately.
	 */
	override async onStart() {
		if (!(await this.getScheduleById("reconcile-outbox"))) {
			await this.scheduleEvery(300, "reconcileOutbox");
		}
		// Catch up on anything left in the outbox from before this hydration.
		try {
			await this.reconcileOutbox();
		} catch (err) {
			console.error("[SozlukTerm.onStart] reconcileOutbox failed", err);
		}
	}

	/**
	 * Drain the outbox: for every row, dispatch the payload to
	 * `PHOENIX_PROJECTION.create`. On success delete the row; on failure
	 * leave it so the next pass re-queues. We dispatch oldest-first
	 * (`ORDER BY created_at ASC`) — forge ULID lex-ordering on `event_id`
	 * means convergence is consistent regardless of dispatch order, but
	 * older rows have spent the most time waiting, so flush them first.
	 *
	 * Idempotent on the projection side (`event_id` is the workflow
	 * instance id; retried `create` with the same id throws "exists" but
	 * we treat any throw as transient and stop draining; the next pass
	 * re-queues).
	 */
	async reconcileOutbox(): Promise<void> {
		const rows = this.sql<{event_id: string; payload: string}>`
			SELECT event_id, payload FROM outbox ORDER BY created_at ASC
		`;
		if (rows.length === 0) return;

		for (const row of rows) {
			try {
				const payload = JSON.parse(row.payload);
				await this.env.PHOENIX_PROJECTION.create({
					id: row.event_id,
					params: payload,
				});
				this.sql`DELETE FROM outbox WHERE event_id = ${row.event_id}`;
			} catch (err) {
				console.error(`[SozlukTerm.reconcileOutbox] dispatch failed for ${row.event_id}`, err);
				// Leave the row; next reconcile pass will retry it.
			}
		}
	}

	/* -------- Reads ------------------------------------------------------ */

	/**
	 * Single term page read. Returns null when the term doesn't exist
	 * (no `term_meta` row yet — `idFromName(slug)` always lands on this DO,
	 * so a missing row means no one's written here yet). Definitions are
	 * filtered by `deleted_at IS NULL`.
	 */
	async getTerm(): Promise<TermPage | null> {
		const meta = await this.db.query.termMeta.findFirst();
		if (!meta) return null;

		const defs = await this.db
			.select()
			.from(schema.definition)
			.where(isNull(schema.definition.deletedAt))
			.orderBy(desc(schema.definition.score), asc(schema.definition.createdAt));

		const firstAt =
			defs.reduce<Date | null>((acc, d) => {
				const c = d.createdAt;
				if (!c) return acc;
				return acc && acc < c ? acc : c;
			}, null) ??
			meta.createdAt ??
			new Date(0);

		const lastEdit =
			defs.reduce<Date | null>((acc, d) => {
				const u = d.updatedAt ?? d.createdAt;
				if (!u) return acc;
				return acc && acc > u ? acc : u;
			}, null) ?? firstAt;

		return {
			id: this.name,
			slug: this.name,
			title: meta.title,
			totalDefinitions: defs.length,
			totalScore: defs.reduce((sum, d) => sum + d.score, 0),
			firstAt,
			lastEdit,
			definitions: defs.map((d) => ({
				id: d.id,
				score: d.score,
				body: d.body,
				author: d.authorName,
				createdAt: d.createdAt ?? new Date(0),
				updatedAt: d.updatedAt ?? d.createdAt ?? new Date(0),
			})),
		};
	}

	/* -------- Seed surface ---------------------------------------------- */

	/**
	 * Admin-only term + definitions upsert. Used by the dev seeder
	 * (`pnpm sozluk:import`) which pulls MDX from the legacy monorepo. The
	 * canonical mutation surface (`addDefinition`) lands in T4 and uses
	 * the producer pattern (atomic outbox + flushOutbox). For seed we
	 * write directly via drizzle and emit a single `TermChanged` event
	 * to populate `term_summary` — same observable read state.
	 *
	 * Idempotent: re-running with the same `(authorId, body)` skips the
	 * existing row.
	 */
	async seed(input: SeedTermInput): Promise<SeedTermResult> {
		const now = Date.now();
		const existing = await this.db.query.termMeta.findFirst();

		if (!existing) {
			await this.db.insert(schema.termMeta).values({
				id: "1",
				title: input.title,
			});
		} else if (existing.title !== input.title) {
			await this.db
				.update(schema.termMeta)
				.set({title: input.title, updatedAt: new Date()})
				.where(eq(schema.termMeta.id, "1"));
		}

		let inserted = 0;
		let skipped = 0;
		for (const def of input.definitions) {
			const dupe = await this.db.query.definition.findFirst({
				where: and(
					eq(schema.definition.authorId, def.authorId),
					eq(schema.definition.body, def.body),
				),
			});
			if (dupe) {
				skipped++;
				continue;
			}
			await this.db.insert(schema.definition).values({
				authorId: def.authorId,
				authorName: def.authorName,
				body: def.body,
				score: def.score ?? 0,
			});
			inserted++;
		}

		// Recompute aggregates from sqlite truth after writes settle.
		const aggregates = await this.recomputeAggregates();

		// Mint a new event id and broadcast the new state. State drives
		// WebSocket broadcasts; outbox + flushOutbox drives the D1 view.
		const eventId = id("evt");
		const nextState: TermState = {
			title: input.title,
			definitionCount: aggregates.definitionCount,
			totalScore: aggregates.totalScore,
			lastActivityAt: now,
			lastEventId: eventId,
		};

		// Atomic outbox row write — synchronous storage API per ADR 0007.
		const payload = JSON.stringify({
			kind: "TermChanged",
			eventId,
			slug: this.name,
			title: input.title,
			definitionCount: aggregates.definitionCount,
			totalScore: aggregates.totalScore,
			topDefinitionId: aggregates.topDefinitionId,
			excerpt: aggregates.excerpt,
			firstAt: aggregates.firstAt,
			lastActivityAt: now,
			lastEditAt: aggregates.lastEditAt,
		});
		this.ctx.storage.transactionSync(() => {
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${eventId}, ${payload}, ${now})
			`;
		});

		this.setState(nextState);

		// Best-effort dispatch. Failure → reconcile picks it up.
		try {
			await this.flushOutbox({eventId});
		} catch (err) {
			console.error("[SozlukTerm.seed] flushOutbox failed", err);
		}

		return {
			created: !existing,
			insertedDefinitions: inserted,
			skippedDefinitions: skipped,
		};
	}

	/**
	 * Wipe every definition + the term_meta row. Used by the dev seeder's
	 * `--clear` flag. The DO instance itself can't be deleted from inside;
	 * cleanup runs at the namespace level when needed.
	 */
	async clearAll(): Promise<{definitions: number; term: boolean}> {
		const defs = await this.db.select({id: schema.definition.id}).from(schema.definition);
		const meta = await this.db.query.termMeta.findFirst();

		await this.db.delete(schema.definitionVote);
		await this.db.delete(schema.definition);
		await this.db.delete(schema.termMeta);
		await this.db.delete(schema.outbox);

		this.setState(INITIAL_STATE);

		return {
			definitions: defs.length,
			term: !!meta,
		};
	}

	/* -------- Mutation surface ------------------------------------------ */

	/**
	 * Canonical write path for adding a definition (T4). Auto-creates the
	 * term row when the slug doesn't exist yet so visiting `/sozluk/<slug>`
	 * for an unknown slug + adding a definition is one round-trip from the
	 * client's perspective.
	 *
	 * Atomicity per ADR 0007: a single `transactionSync` block writes the
	 * term row (if missing), the definition row, and TWO outbox rows
	 * (TermChanged for the convergent aggregate; DefinitionAdded for the
	 * profile-feed view row). Post-commit: `setState` so WebSocket clients
	 * see the new aggregates, then `await this.queue('flushOutbox', …)`
	 * so the events ship to the projection workflow. Failures past the
	 * commit are absorbed by the periodic reconcile.
	 *
	 * Validation:
	 * - body must be non-empty after trimming
	 * - body length ≤ 10 000 chars (raw, not trimmed — clients see the
	 *   exact characters they typed)
	 *
	 * Throws `DefinitionValidationError` for user-facing failures.
	 */
	async addDefinition(input: AddDefinitionInput): Promise<AddDefinitionResult> {
		// ----- validation --------------------------------------------------
		const body = input.body ?? "";
		if (body.trim().length === 0) {
			throw new DefinitionValidationError("body_required", "tanım boş olamaz");
		}
		if (body.length > DEFINITION_BODY_MAX) {
			throw new DefinitionValidationError(
				"body_too_long",
				`tanım en fazla ${DEFINITION_BODY_MAX} karakter olabilir`,
			);
		}

		// ----- read existing term to know if we're creating ----------------
		const existing = await this.db.query.termMeta.findFirst();
		const termCreated = !existing;
		const slug = this.name;
		const title = existing?.title ?? input.termTitle ?? slug.replace(/-/g, " ");

		const definitionId = id("def");
		const now = Date.now();
		const nowDate = new Date(now);

		// ----- atomic write: term (maybe) + definition + outbox rows ------
		// We need the recomputed aggregates BEFORE the transactionSync so
		// the outbox payload is final. Compute the post-write counts from
		// pre-write counts: definitionCount = old + 1; totalScore += 0
		// (new definitions start at score 0 — votes land in T5).
		const preAggregates = await this.recomputeAggregates();
		const definitionCount = preAggregates.definitionCount + 1;
		const totalScore = preAggregates.totalScore;

		// Pre-compute the new excerpt: if no existing top, this becomes top;
		// otherwise existing top (score >= 0) stays.
		const bodyExcerpt = excerpt(body);
		const topDefinitionId = preAggregates.topDefinitionId ?? definitionId;
		const topExcerpt = preAggregates.excerpt ?? bodyExcerpt;
		const firstAt = preAggregates.firstAt ?? now;
		const lastEditAt = now;

		const termEventId = id("evt");
		const definitionEventId = id("evt");

		const termPayload = JSON.stringify({
			kind: "TermChanged",
			eventId: termEventId,
			slug,
			title,
			definitionCount,
			totalScore,
			topDefinitionId,
			excerpt: topExcerpt,
			firstAt,
			lastActivityAt: now,
			lastEditAt,
		});
		const definitionPayload = JSON.stringify({
			kind: "DefinitionAdded",
			eventId: definitionEventId,
			definitionId,
			authorId: input.authorId,
			authorName: input.authorName,
			termSlug: slug,
			termTitle: title,
			bodyExcerpt,
			score: 0,
			createdAt: now,
		});

		// transactionSync requires the synchronous storage API (this.sql).
		// All writes that need to commit-or-rollback together go inside one
		// closure so workerd treats them atomically.
		this.ctx.storage.transactionSync(() => {
			if (termCreated) {
				this.sql`
					INSERT INTO term_meta (id, title, created_at, updated_at)
					VALUES ('1', ${title}, ${Math.floor(now / 1000)}, ${Math.floor(now / 1000)})
				`;
			}
			this.sql`
				INSERT INTO definition (
					id, author_id, author_name, body, score, created_at, updated_at
				) VALUES (
					${definitionId}, ${input.authorId}, ${input.authorName}, ${body}, 0,
					${Math.floor(now / 1000)}, ${Math.floor(now / 1000)}
				)
			`;
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${termEventId}, ${termPayload}, ${now})
			`;
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${definitionEventId}, ${definitionPayload}, ${now})
			`;
		});

		// ----- broadcast new aggregates via setState -----------------------
		// The `lastEventId` carried on state is the most recent outbox event
		// (DefinitionAdded comes after TermChanged in lex order? Both are
		// minted by forge in the same call; the second wins).
		this.setState({
			title,
			definitionCount,
			totalScore,
			lastActivityAt: now,
			lastEventId: definitionEventId,
		});

		// ----- ship the events -------------------------------------------------
		// Best-effort inline flush (cache hit path). Failures are absorbed
		// by the periodic `reconcileOutbox` schedule + on-start reconcile.
		try {
			await this.flushOutbox({eventId: termEventId});
		} catch (err) {
			console.error("[SozlukTerm.addDefinition] flushOutbox(term) failed", err);
		}
		try {
			await this.flushOutbox({eventId: definitionEventId});
		} catch (err) {
			console.error("[SozlukTerm.addDefinition] flushOutbox(definition) failed", err);
		}

		return {
			definitionId,
			termCreated,
			score: 0,
			body,
			authorId: input.authorId,
			authorName: input.authorName,
			createdAt: nowDate,
			updatedAt: nowDate,
		};
	}

	/* -------- Outbox dispatcher ----------------------------------------- */

	/**
	 * Auto-dispatched callback for `this.queue('flushOutbox', {eventId})`.
	 * Reads the outbox row, posts it to `PHOENIX_PROJECTION`, deletes the
	 * row on success. Idempotent: missing row = already flushed.
	 *
	 * Throws on workflow.create failure → caller (`addDefinition` / queue
	 * runner) decides whether to swallow (best-effort flush) or surface
	 * (Agent SDK retries per RetryOptions).
	 */
	async flushOutbox({eventId}: {eventId: string}): Promise<void> {
		const rows = this.sql<{payload: string}>`
			SELECT payload FROM outbox WHERE event_id = ${eventId}
		`;
		if (rows.length === 0) return;

		const payload = JSON.parse(rows[0]!.payload);
		await this.env.PHOENIX_PROJECTION.create({
			id: eventId,
			params: payload,
		});

		this.sql`DELETE FROM outbox WHERE event_id = ${eventId}`;
	}

	/* -------- Internals -------------------------------------------------- */

	/**
	 * Recompute denormalized aggregates from sqlite. Used by both seed and
	 * (in T4+) by mutation methods to assemble the `TermChanged` payload.
	 * Filtered to non-deleted definitions per the read path's contract.
	 */
	private async recomputeAggregates(): Promise<{
		definitionCount: number;
		totalScore: number;
		topDefinitionId: string | null;
		excerpt: string | null;
		firstAt: number | null;
		lastEditAt: number | null;
	}> {
		const rows = await this.db
			.select({
				id: schema.definition.id,
				body: schema.definition.body,
				score: schema.definition.score,
				createdAt: schema.definition.createdAt,
				updatedAt: schema.definition.updatedAt,
			})
			.from(schema.definition)
			.where(isNull(schema.definition.deletedAt))
			.orderBy(desc(schema.definition.score), asc(schema.definition.createdAt));

		if (rows.length === 0) {
			return {
				definitionCount: 0,
				totalScore: 0,
				topDefinitionId: null,
				excerpt: null,
				firstAt: null,
				lastEditAt: null,
			};
		}

		const totalScore = rows.reduce((s, r) => s + r.score, 0);
		const top = rows[0]!;
		const firstAt = rows.reduce<Date | null>((acc, r) => {
			const c = r.createdAt;
			if (!c) return acc;
			return acc && acc < c ? acc : c;
		}, null);
		const lastEditAt = rows.reduce<Date | null>((acc, r) => {
			const u = r.updatedAt ?? r.createdAt;
			if (!u) return acc;
			return acc && acc > u ? acc : u;
		}, null);

		return {
			definitionCount: rows.length,
			totalScore,
			topDefinitionId: top.id,
			excerpt: excerpt(top.body),
			firstAt: firstAt?.getTime() ?? null,
			lastEditAt: lastEditAt?.getTime() ?? null,
		};
	}
}

const EXCERPT_LEN = 140;

function excerpt(body: string): string {
	const flat = body.replace(/\s+/g, " ").trim();
	if (flat.length <= EXCERPT_LEN) return flat;
	return `${flat.slice(0, EXCERPT_LEN - 1).trimEnd()}…`;
}
