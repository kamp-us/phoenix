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
 * (`addDefinition`, `voteDefinition`, `editDefinition`, `deleteDefinition`,
 * …) lands in T4–T6. The outbox table and reconciliation skeletons exist now
 * so those tasks can wire mutations without another schema migration.
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
	/** Pasaport user id of the author. Used by ownership checks (T6). */
	authorId: string;
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

/**
 * Page returned by the connection-shaped definition reader (task_4,
 * phoenix-relay-idiom). Mirrors `CommentConnectionPage` from
 * `PanoPost.ts`. `endCursor` is `null` on an empty page or when
 * `hasNextPage` is `false`. Cursor encoding is opaque to the client; today
 * it's the definition id (forge ULID, lex-sortable). Definitions are
 * ranked by score DESC server-side (matches `getTerm()` ordering); the
 * cursor pages by row index in that materialized order so a stable
 * tie-break (id ASC) survives the keyset boundary.
 */
export interface DefinitionConnectionPage {
	rows: DefinitionRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
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
/* Vote shapes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Thrown by `voteDefinition` / `retractDefinitionVote` when the target
 * definition doesn't exist in this term DO. The resolver translates this to a
 * GraphQL error with `code: 'DEFINITION_NOT_FOUND'`.
 */
export class DefinitionNotFoundError extends Error {
	readonly code = "definition_not_found" as const;
	constructor(definitionId: string) {
		super(`definition ${definitionId} not found in this term`);
		this.name = "DefinitionNotFoundError";
	}
}

export interface VoteDefinitionInput {
	definitionId: string;
	voterId: string;
}

/* -------------------------------------------------------------------------- */
/* Edit / Delete shapes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Thrown by `editDefinition` / `deleteDefinition` when the calling user is
 * not the author of the target definition. The GraphQL resolver translates
 * this to a clean error with `code: 'UNAUTHORIZED'` so the SPA can
 * surface a typed error.
 */
export class UnauthorizedDefinitionMutationError extends Error {
	readonly code = "unauthorized" as const;
	constructor(definitionId: string) {
		super(`not authorized to mutate definition ${definitionId}`);
		this.name = "UnauthorizedDefinitionMutationError";
	}
}

export interface EditDefinitionInput {
	definitionId: string;
	/** Calling user's id — used for the ownership check. */
	actorId: string;
	body: string;
}

export interface EditDefinitionResult {
	definitionId: string;
	score: number;
	body: string;
	authorId: string;
	authorName: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface DeleteDefinitionInput {
	definitionId: string;
	/** Calling user's id — used for the ownership check. */
	actorId: string;
}

export interface DeleteDefinitionResult {
	definitionId: string;
	/** `true` if the row was soft-deleted; `false` on idempotent no-op. */
	deleted: boolean;
}

/**
 * Result returned by both `voteDefinition` and `retractDefinitionVote`. Mirrors
 * the post-write state of the targeted definition so the GraphQL resolver can
 * reconstruct a `Definition` payload without a round-trip read.
 *
 * `myVote` is set authoritatively from the vote-table state so the resolver
 * doesn't have to await the cross-product `user_vote` MV projection (which
 * races with the GraphQL response under load). After a vote, `myVote = 1`;
 * after a retract, `myVote = null`.
 */
export interface VoteDefinitionResult {
	definitionId: string;
	score: number;
	body: string;
	authorId: string;
	authorName: string;
	createdAt: Date;
	updatedAt: Date;
	/** `1` if the voter has voted on this definition (post-write), `null` otherwise. */
	myVote: number | null;
	/** `true` if the vote row state changed; `false` on idempotent no-op. */
	changed: boolean;
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
				authorId: d.authorId,
				createdAt: d.createdAt ?? new Date(0),
				updatedAt: d.updatedAt ?? d.createdAt ?? new Date(0),
			})),
		};
	}

	/**
	 * Connection-shaped read for `Term.definitions(first, after)` (task_4,
	 * phoenix-relay-idiom). Builds on `getTerm()`'s materialized definition
	 * list (already filters `deleted_at IS NULL` and orders by score DESC,
	 * createdAt ASC) and slices a forward page in that ranked order.
	 *
	 * Cursor is the definition id (forge ULID; lex-sortable). `after`
	 * advances past the cursor row; the index lookup tolerates a stale
	 * cursor by collapsing to the head (same behavior as
	 * `listCommentsConnection` and `listPostConnection`).
	 *
	 * Trade-off: full materialization in memory rather than a narrow SQL
	 * slice. Acceptable for the MVP scale (per-term definition lists cap
	 * in the low tens for the busiest terms); can lift to pure SQL keyset
	 * pagination once a flame graph pins this hop.
	 */
	async listDefinitionsConnection(opts: {
		first?: number;
		after?: string | null;
	}): Promise<DefinitionConnectionPage> {
		const term = await this.getTerm();
		if (!term) {
			return {rows: [], hasNextPage: false, endCursor: null, totalCount: 0};
		}
		const sorted = term.definitions;
		const first = Math.max(1, Math.min(opts.first ?? 50, 200));
		const after = opts.after ?? null;
		const startIndex = after ? sorted.findIndex((d) => d.id === after) + 1 : 0;
		const safeStart = startIndex < 0 ? 0 : startIndex;
		const page = sorted.slice(safeStart, safeStart + first);
		const hasNextPage = safeStart + first < sorted.length;
		const last = page.at(-1) ?? null;
		return {
			rows: page,
			hasNextPage,
			endCursor: last ? last.id : null,
			totalCount: sorted.length,
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

	/**
	 * Cast an upvote on a definition (T5). Idempotent: a second vote from the
	 * same voter is a no-op (composite PK + ON CONFLICT DO NOTHING) — the score
	 * stays at 1, no events are emitted.
	 *
	 * Atomicity per ADR 0007: a single `transactionSync` block writes the vote
	 * row, recomputes the definition's denormalized `score` from the vote
	 * table, and emits TWO outbox rows (TermChanged for the recomputed
	 * aggregate; VoteRecorded for the user_vote MV + karma side effect).
	 *
	 * Throws `DefinitionNotFoundError` when `definitionId` doesn't belong to
	 * this term (clients hit the wrong DO via wrong slug).
	 */
	async voteDefinition(input: VoteDefinitionInput): Promise<VoteDefinitionResult> {
		return this.applyVote(input, /* isVote */ true);
	}

	/**
	 * Retract a previously cast upvote (T5). Idempotent: retracting when no
	 * vote exists is a no-op (DELETE … RETURNING returns nothing) — score
	 * unchanged, no events emitted.
	 */
	async retractDefinitionVote(input: VoteDefinitionInput): Promise<VoteDefinitionResult> {
		return this.applyVote(input, /* isVote */ false);
	}

	/**
	 * Shared body for `voteDefinition` and `retractDefinitionVote` — the only
	 * difference is the vote-table mutation (INSERT vs DELETE) and the sign
	 * of the `VoteRecorded` event's `value` field. Centralizing keeps the
	 * outbox + setState contract identical.
	 */
	private async applyVote(
		input: VoteDefinitionInput,
		isVote: boolean,
	): Promise<VoteDefinitionResult> {
		const definitionRow = await this.db.query.definition.findFirst({
			where: and(eq(schema.definition.id, input.definitionId), isNull(schema.definition.deletedAt)),
		});
		if (!definitionRow) {
			throw new DefinitionNotFoundError(input.definitionId);
		}

		const now = Date.now();
		const slug = this.name;

		// Forge ULIDs for the two outbox events (TermChanged + VoteRecorded).
		const termEventId = id("evt");
		const voteEventId = id("evt");

		// Capture state inside the closure so we can read the post-mutation
		// score after transactionSync commits.
		let changed = false;
		let newScore = definitionRow.score;
		let newDefinitionCount = 0;
		let newTotalScore = 0;
		let topDefinitionId: string | null = null;
		let topExcerpt: string | null = null;
		let firstAtMs: number | null = null;
		let lastEditAtMs: number | null = null;
		let bumpScore = false;

		this.ctx.storage.transactionSync(() => {
			if (isVote) {
				// ON CONFLICT DO NOTHING — a re-vote from the same user is a
				// no-op so the denormalized score stays at 1.
				const before = this.sql<{n: number}>`
					SELECT COUNT(*) as n FROM definition_vote
					WHERE definition_id = ${input.definitionId} AND voter_id = ${input.voterId}
				`;
				const existed = (before[0]?.n ?? 0) > 0;
				if (!existed) {
					this.sql`
						INSERT INTO definition_vote (definition_id, voter_id, created_at)
						VALUES (${input.definitionId}, ${input.voterId}, ${Math.floor(now / 1000)})
					`;
					changed = true;
				}
			} else {
				const before = this.sql<{n: number}>`
					SELECT COUNT(*) as n FROM definition_vote
					WHERE definition_id = ${input.definitionId} AND voter_id = ${input.voterId}
				`;
				const existed = (before[0]?.n ?? 0) > 0;
				if (existed) {
					this.sql`
						DELETE FROM definition_vote
						WHERE definition_id = ${input.definitionId} AND voter_id = ${input.voterId}
					`;
					changed = true;
				}
			}

			if (!changed) {
				// Idempotent path — no events, no score recompute.
				newScore = definitionRow.score;
				return;
			}

			// Recompute denormalized score from the vote table (single source).
			const scoreRows = this.sql<{n: number}>`
				SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ${input.definitionId}
			`;
			newScore = scoreRows[0]?.n ?? 0;

			// Persist the new score on the definition row alongside an
			// `updated_at` bump so list ordering and stale-cache windows
			// converge in the same transaction.
			this.sql`
				UPDATE definition SET score = ${newScore}, updated_at = ${Math.floor(now / 1000)}
				WHERE id = ${input.definitionId}
			`;
			bumpScore = true;

			// Recompute term aggregates (definitionCount + totalScore + top
			// definition) from sqlite truth. Reads inside transactionSync use
			// the synchronous `this.sql` API to stay in the closure.
			const aggRows = this.sql<{
				id: string;
				body: string;
				score: number;
				created_at: number | null;
				updated_at: number | null;
			}>`
				SELECT id, body, score, created_at, updated_at
				FROM definition
				WHERE deleted_at IS NULL
				ORDER BY score DESC, created_at ASC
			`;
			newDefinitionCount = aggRows.length;
			newTotalScore = aggRows.reduce((s, r) => s + r.score, 0);
			const top = aggRows[0];
			topDefinitionId = top?.id ?? null;
			topExcerpt = top ? excerpt(top.body) : null;
			firstAtMs = aggRows.reduce<number | null>((acc, r) => {
				if (r.created_at == null) return acc;
				const ms = r.created_at * 1000;
				return acc == null || ms < acc ? ms : acc;
			}, null);
			lastEditAtMs = aggRows.reduce<number | null>((acc, r) => {
				const t = r.updated_at ?? r.created_at;
				if (t == null) return acc;
				const ms = t * 1000;
				return acc == null || ms > acc ? ms : acc;
			}, null);

			// Outbox: TermChanged (term_summary convergence).
			const termPayload = JSON.stringify({
				kind: "TermChanged",
				eventId: termEventId,
				slug,
				title: this.state.title,
				definitionCount: newDefinitionCount,
				totalScore: newTotalScore,
				topDefinitionId,
				excerpt: topExcerpt,
				firstAt: firstAtMs ?? now,
				lastActivityAt: now,
				lastEditAt: lastEditAtMs ?? now,
			});
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${termEventId}, ${termPayload}, ${now})
			`;

			// Outbox: VoteRecorded (user_vote MV + karma).
			const votePayload = JSON.stringify({
				kind: "VoteRecorded",
				eventId: voteEventId,
				userId: input.voterId,
				targetKind: "definition",
				targetId: input.definitionId,
				targetAuthorId: definitionRow.authorId,
				value: isVote,
				createdAt: now,
			});
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${voteEventId}, ${votePayload}, ${now})
			`;
		});

		const updatedAt = bumpScore
			? new Date(now)
			: (definitionRow.updatedAt ?? definitionRow.createdAt ?? new Date(now));

		// Authoritative myVote from the definition_vote table state. After a
		// successful cast, the row exists → 1; after a retract, it's gone → null.
		// Idempotent no-ops also reflect the post-write state correctly: a
		// re-vote leaves the row in place (myVote stays 1); a re-retract leaves
		// nothing (myVote stays null).
		const myVote = isVote ? 1 : null;

		const result: VoteDefinitionResult = {
			definitionId: input.definitionId,
			score: newScore,
			body: definitionRow.body,
			authorId: definitionRow.authorId,
			authorName: definitionRow.authorName,
			createdAt: definitionRow.createdAt ?? new Date(now),
			updatedAt,
			myVote,
			changed,
		};

		if (!changed) return result;

		// Update Agent state (drives WebSocket broadcast in T16).
		this.setState({
			title: this.state.title || slug.replace(/-/g, " "),
			definitionCount: newDefinitionCount,
			totalScore: newTotalScore,
			lastActivityAt: now,
			lastEventId: voteEventId,
		});

		// Best-effort inline flush. Failures absorbed by reconcileOutbox.
		try {
			await this.flushOutbox({eventId: termEventId});
		} catch (err) {
			console.error("[SozlukTerm.applyVote] flushOutbox(term) failed", err);
		}
		try {
			await this.flushOutbox({eventId: voteEventId});
		} catch (err) {
			console.error("[SozlukTerm.applyVote] flushOutbox(vote) failed", err);
		}

		return result;
	}

	/**
	 * Edit a definition's body (T6). Ownership is enforced inside the Agent —
	 * the resolver has already proven the caller is signed-in via `Auth.required`,
	 * but only the row's `author_id` decides who is allowed to mutate it. A
	 * mismatch throws `UnauthorizedDefinitionMutationError`, which the resolver
	 * translates to a GraphQL error with `code: 'UNAUTHORIZED'`.
	 *
	 * Atomicity per ADR 0007: a single `transactionSync` block updates the
	 * `body` + `updated_at` columns, recomputes the term's `lastEditAt`, and
	 * emits TWO outbox rows (TermChanged for the recomputed lastEditAt;
	 * DefinitionEdited for the `definition_view.body_excerpt` refresh). Score
	 * stays unchanged on edit; the term's `totalScore` and `definitionCount`
	 * are unaffected — we still emit `TermChanged` so live readers see the
	 * `lastEditAt` bump.
	 *
	 * Validation mirrors `addDefinition`: trim-empty rejects with
	 * `body_required`; > 10 000 chars rejects with `body_too_long`.
	 */
	async editDefinition(input: EditDefinitionInput): Promise<EditDefinitionResult> {
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

		// ----- existence + ownership check ---------------------------------
		const definitionRow = await this.db.query.definition.findFirst({
			where: and(eq(schema.definition.id, input.definitionId), isNull(schema.definition.deletedAt)),
		});
		if (!definitionRow) {
			throw new DefinitionNotFoundError(input.definitionId);
		}
		if (definitionRow.authorId !== input.actorId) {
			throw new UnauthorizedDefinitionMutationError(input.definitionId);
		}

		const now = Date.now();
		const slug = this.name;
		const termEventId = id("evt");
		const definitionEventId = id("evt");

		const bodyExcerpt = excerpt(body);

		// Recompute term aggregates from current sqlite state (post-edit).
		// totalScore and definitionCount don't change on edit; firstAt is
		// stable; lastEditAt becomes `now`. Top excerpt only changes if the
		// edited definition is the current top; recompute defensively.
		this.ctx.storage.transactionSync(() => {
			this.sql`
				UPDATE definition
				SET body = ${body}, updated_at = ${Math.floor(now / 1000)}
				WHERE id = ${input.definitionId}
			`;

			// Recompute aggregates from sqlite truth inside the closure.
			const aggRows = this.sql<{
				id: string;
				body: string;
				score: number;
				created_at: number | null;
			}>`
				SELECT id, body, score, created_at
				FROM definition
				WHERE deleted_at IS NULL
				ORDER BY score DESC, created_at ASC
			`;
			const definitionCount = aggRows.length;
			const totalScore = aggRows.reduce((s, r) => s + r.score, 0);
			const top = aggRows[0];
			const topDefinitionId = top?.id ?? null;
			const topExcerpt = top ? excerpt(top.body) : null;
			const firstAtMs = aggRows.reduce<number | null>((acc, r) => {
				if (r.created_at == null) return acc;
				const ms = r.created_at * 1000;
				return acc == null || ms < acc ? ms : acc;
			}, null);

			const termPayload = JSON.stringify({
				kind: "TermChanged",
				eventId: termEventId,
				slug,
				title: this.state.title,
				definitionCount,
				totalScore,
				topDefinitionId,
				excerpt: topExcerpt,
				firstAt: firstAtMs ?? now,
				lastActivityAt: now,
				lastEditAt: now,
			});
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${termEventId}, ${termPayload}, ${now})
			`;

			const definitionPayload = JSON.stringify({
				kind: "DefinitionEdited",
				eventId: definitionEventId,
				definitionId: input.definitionId,
				bodyExcerpt,
				updatedAt: now,
			});
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${definitionEventId}, ${definitionPayload}, ${now})
			`;
		});

		// Update Agent state — definitionCount + totalScore unchanged on edit.
		this.setState({
			...this.state,
			lastActivityAt: now,
			lastEventId: definitionEventId,
		});

		// Best-effort inline flush. Failures absorbed by reconcileOutbox.
		try {
			await this.flushOutbox({eventId: termEventId});
		} catch (err) {
			console.error("[SozlukTerm.editDefinition] flushOutbox(term) failed", err);
		}
		try {
			await this.flushOutbox({eventId: definitionEventId});
		} catch (err) {
			console.error("[SozlukTerm.editDefinition] flushOutbox(definition) failed", err);
		}

		return {
			definitionId: input.definitionId,
			score: definitionRow.score,
			body,
			authorId: definitionRow.authorId,
			authorName: definitionRow.authorName,
			createdAt: definitionRow.createdAt ?? new Date(now),
			updatedAt: new Date(now),
		};
	}

	/**
	 * Soft-delete a definition (T6). Ownership-checked the same way as
	 * `editDefinition`. Sets `deleted_at = now` so reads (`getTerm`) filter it
	 * out via `WHERE deleted_at IS NULL` (already the read-path contract from
	 * T2). The term's `definitionCount` and `totalScore` recompute from
	 * non-deleted definitions only.
	 *
	 * Idempotent: re-deleting a row that's already soft-deleted is a no-op
	 * (returns `deleted: false`, no events).
	 *
	 * Outbox: emits `TermChanged` (decremented counts + recomputed top) +
	 * `DefinitionDeleted` (so the `definition_view` row gets `deleted_at`
	 * stamped and the profile feed filters it out).
	 */
	async deleteDefinition(input: DeleteDefinitionInput): Promise<DeleteDefinitionResult> {
		// ----- existence + ownership check ---------------------------------
		// Read the row WITHOUT the deletedAt filter so we can detect "already
		// deleted" as an idempotent no-op (vs. "not found at all").
		const definitionRow = await this.db.query.definition.findFirst({
			where: eq(schema.definition.id, input.definitionId),
		});
		if (!definitionRow) {
			throw new DefinitionNotFoundError(input.definitionId);
		}
		if (definitionRow.authorId !== input.actorId) {
			throw new UnauthorizedDefinitionMutationError(input.definitionId);
		}
		if (definitionRow.deletedAt) {
			// Already soft-deleted → idempotent no-op.
			return {definitionId: input.definitionId, deleted: false};
		}

		const now = Date.now();
		const slug = this.name;
		const termEventId = id("evt");
		const definitionEventId = id("evt");

		// Closure-captured aggregates so setState (after the transactionSync
		// returns) can update Agent state from the same recompute pass.
		let nextDefinitionCount = this.state.definitionCount;
		let nextTotalScore = this.state.totalScore;

		this.ctx.storage.transactionSync(() => {
			this.sql`
				UPDATE definition
				SET deleted_at = ${Math.floor(now / 1000)}, updated_at = ${Math.floor(now / 1000)}
				WHERE id = ${input.definitionId}
			`;

			// Recompute aggregates from non-deleted definitions only.
			const aggRows = this.sql<{
				id: string;
				body: string;
				score: number;
				created_at: number | null;
				updated_at: number | null;
			}>`
				SELECT id, body, score, created_at, updated_at
				FROM definition
				WHERE deleted_at IS NULL
				ORDER BY score DESC, created_at ASC
			`;
			nextDefinitionCount = aggRows.length;
			nextTotalScore = aggRows.reduce((s, r) => s + r.score, 0);
			const top = aggRows[0];
			const topDefinitionId = top?.id ?? null;
			const topExcerpt = top ? excerpt(top.body) : null;
			const firstAtMs = aggRows.reduce<number | null>((acc, r) => {
				if (r.created_at == null) return acc;
				const ms = r.created_at * 1000;
				return acc == null || ms < acc ? ms : acc;
			}, null);
			const lastEditAtMs = aggRows.reduce<number | null>((acc, r) => {
				const t = r.updated_at ?? r.created_at;
				if (t == null) return acc;
				const ms = t * 1000;
				return acc == null || ms > acc ? ms : acc;
			}, null);

			const termPayload = JSON.stringify({
				kind: "TermChanged",
				eventId: termEventId,
				slug,
				title: this.state.title,
				definitionCount: nextDefinitionCount,
				totalScore: nextTotalScore,
				topDefinitionId,
				excerpt: topExcerpt,
				firstAt: firstAtMs ?? now,
				lastActivityAt: now,
				lastEditAt: lastEditAtMs ?? now,
			});
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${termEventId}, ${termPayload}, ${now})
			`;

			const definitionPayload = JSON.stringify({
				kind: "DefinitionDeleted",
				eventId: definitionEventId,
				definitionId: input.definitionId,
				deletedAt: now,
			});
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${definitionEventId}, ${definitionPayload}, ${now})
			`;
		});

		this.setState({
			...this.state,
			definitionCount: nextDefinitionCount,
			totalScore: nextTotalScore,
			lastActivityAt: now,
			lastEventId: definitionEventId,
		});

		try {
			await this.flushOutbox({eventId: termEventId});
		} catch (err) {
			console.error("[SozlukTerm.deleteDefinition] flushOutbox(term) failed", err);
		}
		try {
			await this.flushOutbox({eventId: definitionEventId});
		} catch (err) {
			console.error("[SozlukTerm.deleteDefinition] flushOutbox(definition) failed", err);
		}

		return {definitionId: input.definitionId, deleted: true};
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
