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
	 * Periodic outbox reconciliation (5 min) per ADR 0007. The reconcile
	 * body itself is implemented in T4 along with `flushOutbox`; this
	 * `onStart` only sets the schedule so T4 doesn't need to retroactively
	 * touch lifecycle.
	 */
	override async onStart() {
		if (!(await this.getScheduleById("reconcile-outbox"))) {
			await this.scheduleEvery(300, "reconcileOutbox");
		}
	}

	/**
	 * Stub for the periodic schedule. Real body lands in T4. Throwing here
	 * would loop the schedule; we no-op so the schedule is safely live.
	 */
	async reconcileOutbox(): Promise<void> {
		// Implemented in T4 (mutation surface).
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

	/* -------- Outbox dispatcher ----------------------------------------- */

	/**
	 * Auto-dispatched callback for `this.queue('flushOutbox', {eventId})`
	 * (in T4+). Reads the outbox row, posts it to `PHOENIX_PROJECTION`,
	 * deletes the row on success. Idempotent: missing row = already flushed.
	 *
	 * Throws on workflow.create failure → Agent SDK retries per RetryOptions.
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

