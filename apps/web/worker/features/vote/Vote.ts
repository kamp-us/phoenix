/**
 * Vote — the polymorphic vote service.
 *
 * One canonical write surface for the three vote targets in the system:
 * `definition`, `post`, `comment`. Every up-vote / retract in the product
 * flows through `Vote.cast`. The discriminator is `targetKind`; the value is a
 * tri-state encoded directly (no `kind` field): `value: 1` casts an up-vote,
 * `value: null` retracts. Voting is up-only in the MVP, so a `1 | null` shape
 * makes invalid states (no down-vote semantics) unrepresentable.
 *
 * # Layered idempotency
 *
 * Two PKs collaborate to keep re-casts and re-retracts no-ops:
 *
 *   1. The feature-local vote table (`definition_vote`, `post_vote`,
 *      `comment_vote`) — composite PK on `(target_id, voter_id)`. This is the
 *      SCORE TRUTH source; the cached score on the target row is rebuilt from
 *      `COUNT(*)` on this table inside the same batch.
 *   2. The cross-product `user_vote` table — composite PK on
 *      `(user_id, target_kind, target_id)`. Powers the `myVote` view field.
 *
 * `INSERT … ON CONFLICT DO NOTHING` against each PK turns a second identical
 * cast into a no-op. A pre-write existence probe short-circuits before any
 * write when the target is already in the desired terminal state, so
 * `changed: false` reflects "nothing in the world moved".
 *
 * # Atomicity
 *
 * Every state-changing call lands every mutation in one `batch((db) => [...])`:
 *
 *   - upsert / delete on the feature-local vote table (truth source).
 *   - score-cache update on the target row, derived from a `COUNT(*)`
 *     subquery against the vote table in the same statement.
 *   - upsert / delete on `user_vote`.
 *   - karma counter bump / decrement on the target author's `user_profile`
 *     via {@link karmaBumpStatement}.
 *
 * If any statement in the batch fails, the whole batch rolls back — the vote
 * insert, score update, mirror, and karma bump commit together or not at all.
 *
 * # Surface
 *
 *   Vote.cast({ userId, targetKind, targetId, value: 1 | null }) → VoteResult
 *
 * The result carries the new (cached) score, the post-write `myVote` flag, a
 * `changed` boolean, and target identity. Feature-specific resolver shapes
 * (titles, bodies, host, etc.) stay in feature services — they re-read the
 * target row after `Vote.cast` rather than threading every column through
 * this contract.
 */
import {and, eq, inArray, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, type DrizzleError} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {karmaBumpStatement} from "../pasaport/karma.ts";
import {type VoteTargetKind, VoteTargetNotFound} from "./errors.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

// Re-export the domain kind from `errors.ts` (its source-of-truth home) so
// downstream callers can keep importing it from `./Vote` if they prefer.
export type {VoteTargetKind};

/**
 * `1` casts an up-vote; `null` retracts. The MVP is up-only.
 */
export type VoteValue = 1 | null;

export interface VoteInput {
	userId: string;
	targetKind: VoteTargetKind;
	targetId: string;
	value: VoteValue;
}

export interface VoteResult {
	targetKind: VoteTargetKind;
	targetId: string;
	/** Denormalized score after the write (re-sum from truth source). */
	score: number;
	/** `1` if the user has a `user_vote` row for the target post-write, else `null`. */
	myVote: number | null;
	/** `true` when the write changed underlying state; `false` on idempotent no-op. */
	changed: boolean;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

export class Vote extends Context.Service<
	Vote,
	{
		readonly cast: (
			input: VoteInput,
		) => Effect.Effect<VoteResult, VoteTargetNotFound | DrizzleError>;
		/**
		 * Batched `myVote` presence read. Returns the subset of `targetIds` the
		 * viewer has a `user_vote` row for, of the given `kind` — one `WHERE
		 * user_id = ? AND target_kind = ? AND target_id IN (...)` read so callers
		 * stamp `myVote` without an N+1. A missing viewer or empty `targetIds`
		 * short-circuits to an empty Set with no read.
		 */
		readonly readMine: (
			viewerId: string | null | undefined,
			kind: VoteTargetKind,
			targetIds: ReadonlyArray<string>,
		) => Effect.Effect<Set<string>, DrizzleError>;
	}
>()("@phoenix/vote/Vote") {}

/* -------------------------------------------------------------------------- */
/* Live layer                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Per-target metadata resolved before the write. `authorId` is the karma
 * recipient; `createdAtMs` is the target's epoch ms (used by post hot-score
 * recompute).
 */
interface TargetMeta {
	authorId: string;
	createdAtMs: number;
}

export const VoteLive = Layer.effect(Vote)(
	Effect.gen(function* () {
		// Per the post-fbb57d8 reshape: yield Drizzle once at layer build and
		// destructure its bound methods. Method bodies call `run` / `batch`
		// directly so every method's `R` stays `never`. No closure-captured
		// `db` escapes — `db` only appears inside `run((db) => ...)` /
		// `batch((db) => ...)` callbacks.
		const {run, batch} = yield* Drizzle;

		// ── Per-target metadata lookup ────────────────────────────────────
		// Each target kind has its own view table holding `author_id` +
		// `created_at` (and soft-delete). One read on the write path; if the
		// row is missing or soft-deleted we surface `VoteTargetNotFound`
		// rather than letting the batch fail with an FK-shaped error.
		const loadMeta = Effect.fn("Vote.loadMeta")(function* (kind: VoteTargetKind, targetId: string) {
			switch (kind) {
				case "definition": {
					const row = yield* run((db) =>
						db.query.definitionView.findFirst({
							where: and(
								eq(schema.definitionView.id, targetId),
								isNull(schema.definitionView.deletedAt),
							),
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
							where: and(eq(schema.postSummary.id, targetId), isNull(schema.postSummary.deletedAt)),
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
						db.query.commentView.findFirst({
							where: and(eq(schema.commentView.id, targetId), isNull(schema.commentView.deletedAt)),
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

		// ── Idempotency probe ─────────────────────────────────────────────
		// One indexed point-lookup against the feature-local vote table to
		// decide if the write would be a no-op. Skipping the batch on the
		// `isCast === alreadyCast` path keeps idempotent re-casts and
		// re-retracts as cheap reads.
		const probeExisting = (kind: VoteTargetKind, targetId: string, userId: string) =>
			run(async (db) => {
				switch (kind) {
					case "definition": {
						const row = await db.query.definitionVote.findFirst({
							where: and(
								eq(schema.definitionVote.definitionId, targetId),
								eq(schema.definitionVote.voterId, userId),
							),
						});
						return row != null;
					}
					case "post": {
						const row = await db.query.postVote.findFirst({
							where: and(eq(schema.postVote.postId, targetId), eq(schema.postVote.voterId, userId)),
						});
						return row != null;
					}
					case "comment": {
						const row = await db.query.commentVote.findFirst({
							where: and(
								eq(schema.commentVote.commentId, targetId),
								eq(schema.commentVote.voterId, userId),
							),
						});
						return row != null;
					}
				}
			});

		// ── Cached-score readback ─────────────────────────────────────────
		// Read truth-derived score back from the cache the batch just
		// refreshed. One indexed point lookup; also serves the idempotent
		// path's tail.
		const readCachedScore = (kind: VoteTargetKind, targetId: string) =>
			run(async (db) => {
				switch (kind) {
					case "definition": {
						const row = await db.query.definitionView.findFirst({
							where: eq(schema.definitionView.id, targetId),
							columns: {score: true},
						});
						return row?.score ?? 0;
					}
					case "post": {
						const row = await db.query.postSummary.findFirst({
							where: eq(schema.postSummary.id, targetId),
							columns: {score: true},
						});
						return row?.score ?? 0;
					}
					case "comment": {
						const row = await db.query.commentView.findFirst({
							where: eq(schema.commentView.id, targetId),
							columns: {score: true},
						});
						return row?.score ?? 0;
					}
				}
			});

		// ── Batched `myVote` presence read ────────────────────────────────
		// One `WHERE user_id = ? AND target_kind = ? AND target_id IN (...)`
		// read over the cross-product `user_vote` table — `Vote` owns this
		// table, so the batched `myVote` stamp lives here rather than being
		// hand-rolled in each consuming feature (Pano/Sözlük). A missing viewer
		// or empty id list short-circuits without a read.
		const readMine = Effect.fn("Vote.readMine")(function* (
			viewerId: string | null | undefined,
			kind: VoteTargetKind,
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
				const isCast = input.value === 1;
				const alreadyCast = yield* probeExisting(input.targetKind, input.targetId, input.userId);

				if (isCast === alreadyCast) {
					// Idempotent path: state matches intent, no write. Return
					// the cached score as-is.
					const score = yield* readCachedScore(input.targetKind, input.targetId);
					return {
						targetKind: input.targetKind,
						targetId: input.targetId,
						score,
						myVote: alreadyCast ? 1 : null,
						changed: false,
					} satisfies VoteResult;
				}

				// State change. One batch carries every mutation: the
				// feature-local vote row (truth source) leads, followed by the
				// score-cache update (re-counts truth via `COUNT(*)` subquery,
				// so concurrent `ON CONFLICT DO NOTHING` collisions self-heal),
				// the `user_vote` cross-product row, and the karma counter via
				// `karmaBumpStatement`.
				const karmaDelta = isCast ? 1 : -1;

				yield* batch((db) => buildBatchStatements(db, input, meta, isCast, karmaDelta, now));

				const newScore = yield* readCachedScore(input.targetKind, input.targetId);

				return {
					targetKind: input.targetKind,
					targetId: input.targetId,
					score: newScore,
					myVote: isCast ? 1 : null,
					changed: true,
				} satisfies VoteResult;
			}),
		};
	}),
);

/* -------------------------------------------------------------------------- */
/* Batch statement builders                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the tuple of statements that make up one atomic state-change. Either
 * every statement commits or none do — `db.batch([...])` is D1's native batch
 * primitive. The first element is the vote-table mutation (truth source); the
 * second is the score-cache update derived from a `COUNT(*)` subquery; the
 * third mirrors `user_vote`; the fourth bumps karma via
 * {@link karmaBumpStatement}.
 */
function buildBatchStatements(
	db: DrizzleDb,
	input: VoteInput,
	meta: TargetMeta,
	isCast: boolean,
	karmaDelta: number,
	now: Date,
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

	const karma = karmaBumpStatement(db, meta.authorId, karmaDelta);

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
 * Build the score-cache UPDATE for the target row. The new score is derived
 * from a `COUNT(*)` subquery against the truth-source vote table inside the
 * same UPDATE, so the cache always reflects truth after the batch — concurrent
 * `ON CONFLICT DO NOTHING` collisions on the vote table self-heal.
 *
 * Posts additionally carry a precomputed `hot_score` (SQLite has no `POW`, so
 * the multiplier is computed in JS and bound in).
 */
function buildScoreCacheStatement(
	db: DrizzleDb,
	kind: VoteTargetKind,
	targetId: string,
	now: Date,
	meta: TargetMeta,
) {
	switch (kind) {
		case "definition":
			return db
				.update(schema.definitionView)
				.set({
					score: sql`(SELECT COUNT(*) FROM ${schema.definitionVote} WHERE ${schema.definitionVote.definitionId} = ${targetId})`,
					updatedAt: now,
				})
				.where(eq(schema.definitionView.id, targetId));
		case "post": {
			// Same hot-score formula as `pano/module.ts` on submit:
			//   floor(score * 1000 / (hours+2)^1.8)
			// Precompute the multiplier in JS so SQL only multiplies.
			const hoursOld = Math.max(0, (now.getTime() - meta.createdAtMs) / 3_600_000);
			const hotMultiplier = 1000 / (hoursOld + 2) ** 1.8;
			return db
				.update(schema.postSummary)
				.set({
					score: sql`(SELECT COUNT(*) FROM ${schema.postVote} WHERE ${schema.postVote.postId} = ${targetId})`,
					hotScore: sql`CAST((SELECT COUNT(*) FROM ${schema.postVote} WHERE ${schema.postVote.postId} = ${targetId}) * ${hotMultiplier} AS INTEGER)`,
					updatedAt: now,
					lastActivityAt: now,
				})
				.where(eq(schema.postSummary.id, targetId));
		}
		case "comment":
			return db
				.update(schema.commentView)
				.set({
					score: sql`(SELECT COUNT(*) FROM ${schema.commentVote} WHERE ${schema.commentVote.commentId} = ${targetId})`,
					updatedAt: now,
				})
				.where(eq(schema.commentView.id, targetId));
	}
}
