/**
 * Vote — the polymorphic vote service. One canonical write surface
 * (`Vote.cast`) for the three vote targets: `definition`, `post`, `comment`.
 *
 * Voting is up-only in the MVP: a vote is a pure presence — `cast({value: true})`
 * casts, `{value: false}` retracts — so invalid states (down-vote semantics, a
 * vote *weight*) are structurally unrepresentable; there is no number to misuse.
 *
 * The feature-local vote table (`definition_vote`/`post_vote`/`comment_vote`,
 * PK `(target_id, voter_id)`) is the score-truth source; the score cached on
 * the target row is rebuilt from `COUNT(*)` on it. The cross-product
 * `user_vote` table (PK `(user_id, target_kind, target_id)`) powers `myVote`.
 *
 * Atomicity invariant: every state-changing cast lands all four mutations —
 * vote-table upsert/delete, score-cache update, `user_vote` mirror, and karma
 * bump (via {@link KarmaBump}) — in one batch that commits or rolls back as a
 * unit. See ADR 0014 (batch as service method).
 */
import {and, eq, inArray, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess, type Stmt} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {hotMultiplier} from "../../db/hotScore.ts";
import type {TargetKind} from "../../db/target-kind.ts";
import {VoteTargetNotFound} from "./errors.ts";

// Re-exported from `db/target-kind.ts` (its source-of-truth home) for callers
// that prefer importing it from `./Vote`.
export type {TargetKind};

export interface VoteInput {
	userId: string;
	targetKind: TargetKind;
	targetId: string;
	/** Up-only presence intent: `true` casts the upvote, `false` retracts it. */
	value: boolean;
}

export interface VoteResult {
	targetKind: TargetKind;
	targetId: string;
	score: number;
	/** Whether the voter holds an upvote on this target after the write. */
	myVote: boolean;
	/** `false` on idempotent no-op. */
	changed: boolean;
}

/**
 * The karma-bump capability as Vote consumes it: given recipient and delta
 * (`+1` cast, `-1` retraction), the **unexecuted** statement to include in the
 * cast batch — so the karma adjustment commits atomically with the vote, or
 * not at all.
 */
export interface KarmaBumpService {
	readonly statement: (db: DrizzleDb, userId: string, delta: number) => Stmt;
}

/**
 * The contract Vote OWNS for the karma side-effect of a cast (dependency
 * inversion). Vote is a shared low-level service (Sözlük and Pano both delegate
 * to it), so it must not import a feature directory: it declares what it needs
 * and the implementation arrives at layer composition (pasaport, via
 * `fate/layers.ts`). This is also the swap point for a future DO-backed Künye
 * karma bump — if that can't be expressed as a D1 batch statement, this
 * contract is the thing to renegotiate, not Vote's internals.
 */
export class KarmaBump extends Context.Service<KarmaBump, KarmaBumpService>()(
	"@kampus/vote/KarmaBump",
) {}

export class Vote extends Context.Service<
	Vote,
	{
		readonly cast: (input: VoteInput) => Effect.Effect<VoteResult, VoteTargetNotFound>;
		/**
		 * Batched `myVote` presence read: the subset of `targetIds` the viewer has
		 * a `user_vote` row for, of the given `kind`, in one `IN (...)` read so
		 * callers stamp `myVote` without an N+1. Missing viewer or empty
		 * `targetIds` short-circuits to an empty Set with no read.
		 */
		readonly readMine: (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
		) => Effect.Effect<Set<string>>;
		/**
		 * The single vote-cleanup home for the removal substrate (ADR 0096 §3):
		 * wipe the per-target vote rows (`*_vote`) and the `user_vote` mirror for one
		 * target, in **one** D1 batch (ADR 0014). Karma is **KEPT** — there is no
		 * `total_karma` decrement here, so removing content never reverses the karma
		 * its upvotes earned (sözlük's keep rule, generalized; pano's reversal is
		 * deleted). The caller stamps `Removed` on the content row and recomputes the
		 * summary caches outside this batch (recomputable caches, ADR 0011/0096).
		 */
		readonly clearTarget: (kind: TargetKind, targetId: string) => Effect.Effect<void>;
	}
>()("@kampus/vote/Vote") {}

/**
 * Per-target metadata resolved before the write. `authorId` is the karma
 * recipient; `createdAtMs` feeds the post hot-score recompute.
 */
interface TargetMeta {
	authorId: string;
	createdAtMs: number;
}

export const VoteLive = Layer.effect(Vote)(
	Effect.gen(function* () {
		// `orDieAccess`: every internal DB call site dies on `DrizzleError`
		// (infra failures are defects — the domain-boundary rule), so public
		// signatures carry domain errors only and `R` stays `never`.
		const {run, batch} = orDieAccess(yield* Drizzle);
		const karmaBump = yield* KarmaBump;

		// Per-target metadata lookup. If the row is missing or removed we
		// surface `VoteTargetNotFound` rather than letting the batch fail with
		// an FK-shaped error.
		const loadMeta = Effect.fn("Vote.loadMeta")(function* (kind: TargetKind, targetId: string) {
			switch (kind) {
				case "definition": {
					const row = yield* run((db) =>
						db.query.definitionRecord.findFirst({
							where: {id: targetId, removedAt: {isNull: true}},
						}),
					);
					if (!row) {
						return yield* new VoteTargetNotFound({
							targetKind: "definition",
							targetId,
							message: `vote target definition ${targetId} not found`,
						});
					}
					return {
						authorId: row.authorId,
						createdAtMs: (row.createdAt ?? new Date()).getTime(),
					} satisfies TargetMeta;
				}
				case "post": {
					const row = yield* run((db) =>
						db.query.postSummary.findFirst({
							where: {id: targetId, removedAt: {isNull: true}},
						}),
					);
					if (!row) {
						return yield* new VoteTargetNotFound({
							targetKind: "post",
							targetId,
							message: `vote target post ${targetId} not found`,
						});
					}
					return {
						authorId: row.authorId,
						createdAtMs: (row.createdAt ?? new Date()).getTime(),
					} satisfies TargetMeta;
				}
				case "comment": {
					const row = yield* run((db) =>
						db.query.commentRecord.findFirst({
							where: {id: targetId, removedAt: {isNull: true}},
						}),
					);
					if (!row) {
						return yield* new VoteTargetNotFound({
							targetKind: "comment",
							targetId,
							message: `vote target comment ${targetId} not found`,
						});
					}
					return {
						authorId: row.authorId,
						createdAtMs: (row.createdAt ?? new Date()).getTime(),
					} satisfies TargetMeta;
				}
			}
		});

		// Idempotency probe: one point-lookup against the vote table to decide
		// if the write would be a no-op, so re-casts/re-retracts stay cheap
		// reads (the `isCast === alreadyCast` path skips the batch).
		const probeExisting = (kind: TargetKind, targetId: string, userId: string) =>
			run(async (db) => {
				switch (kind) {
					case "definition": {
						const row = await db.query.definitionVote.findFirst({
							where: {definitionId: targetId, voterId: userId},
						});
						return row != null;
					}
					case "post": {
						const row = await db.query.postVote.findFirst({
							where: {postId: targetId, voterId: userId},
						});
						return row != null;
					}
					case "comment": {
						const row = await db.query.commentVote.findFirst({
							where: {commentId: targetId, voterId: userId},
						});
						return row != null;
					}
				}
			});

		// Read the truth-derived score back from the cache the batch just
		// refreshed; also serves the idempotent path's tail.
		const readCachedScore = (kind: TargetKind, targetId: string) =>
			run(async (db) => {
				switch (kind) {
					case "definition": {
						const row = await db.query.definitionRecord.findFirst({
							where: {id: targetId},
							columns: {score: true},
						});
						return row?.score ?? 0;
					}
					case "post": {
						const row = await db.query.postSummary.findFirst({
							where: {id: targetId},
							columns: {score: true},
						});
						return row?.score ?? 0;
					}
					case "comment": {
						const row = await db.query.commentRecord.findFirst({
							where: {id: targetId},
							columns: {score: true},
						});
						return row?.score ?? 0;
					}
				}
			});

		// Lives here (not in each consuming feature) because Vote owns the
		// cross-product `user_vote` table. See the `readMine` interface doc.
		const readMine = Effect.fn("Vote.readMine")(function* (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
		) {
			if (!viewerId || targetIds.length === 0) return new Set<string>();
			const rows = yield* run((db) =>
				db
					.select({targetId: schema.userVote.targetId})
					.from(schema.userVote)
					.where(
						and(
							eq(schema.userVote.userId, viewerId),
							eq(schema.userVote.targetKind, kind),
							inArray(schema.userVote.targetId, [...targetIds]),
						),
					),
			);
			return new Set(rows.map((r) => r.targetId));
		});

		return {
			readMine,
			cast: Effect.fn("Vote.cast")(function* (input: VoteInput) {
				const meta = yield* loadMeta(input.targetKind, input.targetId);

				const now = new Date();
				const isCast = input.value;
				const alreadyCast = yield* probeExisting(input.targetKind, input.targetId, input.userId);

				if (isCast === alreadyCast) {
					// State matches intent: no write, return the cached score.
					const score = yield* readCachedScore(input.targetKind, input.targetId);
					return {
						targetKind: input.targetKind,
						targetId: input.targetId,
						score,
						myVote: alreadyCast,
						changed: false,
					} satisfies VoteResult;
				}

				// State change — see `buildBatchStatements` for the atomic batch.
				const karmaDelta = isCast ? 1 : -1;

				yield* batch((db) =>
					buildBatchStatements(db, input, meta, isCast, karmaDelta, now, karmaBump),
				);

				const newScore = yield* readCachedScore(input.targetKind, input.targetId);

				return {
					targetKind: input.targetKind,
					targetId: input.targetId,
					score: newScore,
					myVote: isCast,
					changed: true,
				} satisfies VoteResult;
			}),
			clearTarget: Effect.fn("Vote.clearTarget")(function* (kind: TargetKind, targetId: string) {
				yield* batch((db) => buildClearTargetStatements(db, kind, targetId));
			}),
		};
	}),
);

/**
 * The two statements clearing one target's votes: the per-target `*_vote` rows
 * and the `user_vote` mirror, no karma touched. `db.batch` commits both or
 * neither (ADR 0014), so a removed entity never carries orphan vote rows.
 */
function buildClearTargetStatements(db: DrizzleDb, kind: TargetKind, targetId: string) {
	const userVoteWipe = db
		.delete(schema.userVote)
		.where(and(eq(schema.userVote.targetKind, kind), eq(schema.userVote.targetId, targetId)));
	switch (kind) {
		case "definition":
			return [
				db.delete(schema.definitionVote).where(eq(schema.definitionVote.definitionId, targetId)),
				userVoteWipe,
			] as const;
		case "post":
			return [
				db.delete(schema.postVote).where(eq(schema.postVote.postId, targetId)),
				userVoteWipe,
			] as const;
		case "comment":
			return [
				db.delete(schema.commentVote).where(eq(schema.commentVote.commentId, targetId)),
				userVoteWipe,
			] as const;
	}
}

/**
 * The tuple of statements making up one atomic state-change, in order:
 * vote-table mutation (truth source), score-cache update, `user_vote` mirror,
 * karma bump. `db.batch([...])` commits all or none. See ADR 0014.
 */
function buildBatchStatements(
	db: DrizzleDb,
	input: VoteInput,
	meta: TargetMeta,
	isCast: boolean,
	karmaDelta: number,
	now: Date,
	karmaBump: KarmaBumpService,
) {
	const voteRow = isCast ? buildVoteInsert(db, input, now) : buildVoteDelete(db, input);

	const scoreUpdate = buildScoreCacheStatement(db, input.targetKind, input.targetId, now, meta);

	const userVoteRow = isCast
		? db
				.insert(schema.userVote)
				.values({
					userId: input.userId,
					targetKind: input.targetKind,
					targetId: input.targetId,
					createdAt: now,
				})
				.onConflictDoNothing()
		: db
				.delete(schema.userVote)
				.where(
					and(
						eq(schema.userVote.userId, input.userId),
						eq(schema.userVote.targetKind, input.targetKind),
						eq(schema.userVote.targetId, input.targetId),
					),
				);

	const karma = karmaBump.statement(db, meta.authorId, karmaDelta);

	return [voteRow, scoreUpdate, userVoteRow, karma] as const;
}

function buildVoteInsert(db: DrizzleDb, input: VoteInput, now: Date) {
	switch (input.targetKind) {
		case "definition":
			return db
				.insert(schema.definitionVote)
				.values({
					definitionId: input.targetId,
					voterId: input.userId,
					createdAt: now,
				})
				.onConflictDoNothing();
		case "post":
			return db
				.insert(schema.postVote)
				.values({
					postId: input.targetId,
					voterId: input.userId,
					createdAt: now,
				})
				.onConflictDoNothing();
		case "comment":
			return db
				.insert(schema.commentVote)
				.values({
					commentId: input.targetId,
					voterId: input.userId,
					createdAt: now,
				})
				.onConflictDoNothing();
	}
}

function buildVoteDelete(db: DrizzleDb, input: VoteInput) {
	switch (input.targetKind) {
		case "definition":
			return db
				.delete(schema.definitionVote)
				.where(
					and(
						eq(schema.definitionVote.definitionId, input.targetId),
						eq(schema.definitionVote.voterId, input.userId),
					),
				);
		case "post":
			return db
				.delete(schema.postVote)
				.where(
					and(
						eq(schema.postVote.postId, input.targetId),
						eq(schema.postVote.voterId, input.userId),
					),
				);
		case "comment":
			return db
				.delete(schema.commentVote)
				.where(
					and(
						eq(schema.commentVote.commentId, input.targetId),
						eq(schema.commentVote.voterId, input.userId),
					),
				);
	}
}

/**
 * Score-cache UPDATE for the target row. The new score is a `COUNT(*)` subquery
 * against the truth-source vote table inside the same UPDATE, so the cache
 * reflects truth after the batch and concurrent `ON CONFLICT DO NOTHING`
 * collisions self-heal. Posts also carry a precomputed `hot_score` — SQLite has
 * no `POW`, so the multiplier is computed in JS and bound in.
 */
function buildScoreCacheStatement(
	db: DrizzleDb,
	kind: TargetKind,
	targetId: string,
	now: Date,
	meta: TargetMeta,
) {
	switch (kind) {
		case "definition":
			return db
				.update(schema.definitionRecord)
				.set({
					score: sql`(SELECT COUNT(*) FROM ${schema.definitionVote} WHERE ${schema.definitionVote.definitionId} = ${targetId})`,
					updatedAt: now,
				})
				.where(eq(schema.definitionRecord.id, targetId));
		case "post": {
			const multiplier = hotMultiplier(meta.createdAtMs, now.getTime());
			return db
				.update(schema.postSummary)
				.set({
					score: sql`(SELECT COUNT(*) FROM ${schema.postVote} WHERE ${schema.postVote.postId} = ${targetId})`,
					hotScore: sql`CAST((SELECT COUNT(*) FROM ${schema.postVote} WHERE ${schema.postVote.postId} = ${targetId}) * ${multiplier} AS INTEGER)`,
					updatedAt: now,
					lastActivityAt: now,
				})
				.where(eq(schema.postSummary.id, targetId));
		}
		case "comment":
			return db
				.update(schema.commentRecord)
				.set({
					score: sql`(SELECT COUNT(*) FROM ${schema.commentVote} WHERE ${schema.commentVote.commentId} = ${targetId})`,
					updatedAt: now,
				})
				.where(eq(schema.commentRecord.id, targetId));
	}
}
