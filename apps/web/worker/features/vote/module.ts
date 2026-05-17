/**
 * Vote module.
 *
 * One canonical write surface for the three vote targets in the system:
 * `definition`, `post`, `comment`. Every vote in the product flows through
 * `vote(env, input)`. The discriminator is `targetKind`; the value is a
 * tri-state encoded directly (no `kind` field): `value: 1` casts an up-vote,
 * `value: null` retracts. Voting is up-only in the MVP, so a `1 | null` shape
 * makes invalid states (e.g. `-1` with no down-vote semantics) unrepresentable.
 *
 * # Layered idempotency
 *
 * Two PKs collaborate to keep re-casts and re-retracts no-ops:
 *
 *  1. The feature-local vote table (`definition_vote`, `post_vote`,
 *     `comment_vote`) — composite PK on `(target_id, voter_id)`. This is the
 *     SCORE TRUTH source; the cached score on the target row is rebuilt from
 *     `COUNT(*)` on this table after every state change (see Atomicity).
 *  2. The cross-product `user_vote` table — composite PK on
 *     `(user_id, target_kind, target_id)`. This powers the `myVote` GraphQL
 *     field via `readMyVote` and is the row whose existence the acceptance
 *     criterion treats as the canonical "user has voted on target X" signal.
 *
 * `INSERT OR IGNORE` against each PK turns a second identical cast into a
 * no-op. The module short-circuits before issuing any write when the
 * pre-write probe shows the target is already in the desired terminal state
 * (`isCast === alreadyCast`), so `changed: false` reflects "nothing in the
 * world moved" rather than "the write happened to be a SQL no-op".
 *
 * # Atomicity
 *
 * All side-effects of a state-changing vote write land in one
 * `env.PHOENIX_DB.batch(...)` call:
 *
 *   - upsert / delete on the feature-local vote table (truth source).
 *   - score-cache update on the target row — derived from a `COUNT(*)`
 *     subquery against the vote table in the same statement, so the cache
 *     re-syncs to truth atomically within the batch.
 *   - upsert / delete on `user_vote`.
 *   - karma counter bump / decrement on the author's `user_profile`.
 *
 * No mutation precedes the batch — the only read on the write path is the
 * pre-write existence probe, which is read-only. Two concurrent identical
 * casts that both pass the existence probe still converge on a single row
 * because the vote-table `INSERT OR IGNORE` ignores the second, and the
 * score-cache subquery re-counts truth either way; whichever batch commits
 * last wins, with the same correct count. (Karma is a separate increment
 * not derived from truth; same-voter concurrent dup casts can double-count
 * karma — a residual race tracked outside this module.)
 *
 * # Surface
 *
 *   vote(env, {
 *     userId,
 *     targetKind: 'definition' | 'post' | 'comment',
 *     targetId,
 *     value: 1 | null,
 *   }) → VoteResult
 *
 * The result intentionally carries only what every caller needs: the new
 * score (denormalized cache value), the `myVote` flag post-write, a
 * `changed` boolean, and target identity. Feature-specific resolver shapes
 * (titles, bodies, host, etc.) stay in feature modules — they re-read the
 * target row after dispatching to `vote()` rather than threading every
 * column through this contract.
 */
import {and, eq, isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../db/drizzle/schema";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type VoteTargetKind = "definition" | "post" | "comment";

/**
 * `1` casts an up-vote; `null` retracts. The MVP is up-only, so this binary
 * is sufficient — when down-votes ship, swap to `1 | -1 | null` and the
 * discriminator on `value` continues to do the work.
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

/**
 * Raised when the target row doesn't exist (or is soft-deleted) at write
 * time. Resolvers map this to a typed `extensions.code` via the graphql
 * error codec (`worker/graphql/errors.ts`).
 */
export class VoteTargetNotFoundError extends Error {
	readonly code = "vote_target_not_found" as const;
	constructor(
		readonly targetKind: VoteTargetKind,
		readonly targetId: string,
	) {
		super(`vote target ${targetKind} ${targetId} not found`);
		this.name = "VoteTargetNotFoundError";
	}
}

/* -------------------------------------------------------------------------- */
/* Per-target adapters                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Internal handle resolved before any write: `authorId` is the karma
 * recipient; `createdAtMs` is the target's epoch ms (used by post hot-score
 * recompute); `voteTable` / `idColumn` name the score-truth table & PK
 * column so the score-cache update can be generic.
 */
interface TargetMeta {
	authorId: string;
	createdAtMs: number;
}

interface TargetAdapter {
	/** Resolve target meta or throw `VoteTargetNotFoundError`. */
	loadMeta(env: Env, targetId: string): Promise<TargetMeta>;
	/** The feature-local vote table name (`definition_vote` / `post_vote` / `comment_vote`). */
	voteTable: string;
	/** The id column name on `voteTable` (`definition_id` / `post_id` / `comment_id`). */
	voteIdColumn: string;
	/**
	 * Build the score-cache update statements for the target row. The new
	 * score is derived from a `COUNT(*)` subquery against the vote table
	 * inside the same UPDATE, so the cache always reflects truth after the
	 * batch — concurrent INSERT OR IGNORE collisions self-heal.
	 */
	scoreCacheStatements(
		env: Env,
		args: {targetId: string; now: Date; meta: TargetMeta},
	): D1PreparedStatement[];
}

function definitionAdapter(): TargetAdapter {
	return {
		voteTable: "definition_vote",
		voteIdColumn: "definition_id",
		async loadMeta(env, definitionId) {
			const db = drizzle(env.PHOENIX_DB, {schema});
			const row = await db.query.definitionView.findFirst({
				where: and(
					eq(schema.definitionView.id, definitionId),
					isNull(schema.definitionView.deletedAt),
				),
			});
			if (!row) {
				throw new VoteTargetNotFoundError("definition", definitionId);
			}
			return {
				authorId: row.authorId,
				createdAtMs: (row.createdAt ?? new Date()).getTime(),
			};
		},
		scoreCacheStatements(env, {targetId, now}) {
			const nowSec = Math.floor(now.getTime() / 1000);
			return [
				env.PHOENIX_DB.prepare(
					`UPDATE definition_view
					 SET score = (SELECT COUNT(*) FROM definition_vote WHERE definition_id = ?),
						 updated_at = ?
					 WHERE id = ?`,
				).bind(targetId, nowSec, targetId),
			];
		},
	};
}

function postAdapter(): TargetAdapter {
	return {
		voteTable: "post_vote",
		voteIdColumn: "post_id",
		async loadMeta(env, postId) {
			const db = drizzle(env.PHOENIX_DB, {schema});
			const row = await db.query.postSummary.findFirst({
				where: and(eq(schema.postSummary.id, postId), isNull(schema.postSummary.deletedAt)),
			});
			if (!row) {
				throw new VoteTargetNotFoundError("post", postId);
			}
			return {
				authorId: row.authorId,
				createdAtMs: (row.createdAt ?? new Date()).getTime(),
			};
		},
		scoreCacheStatements(env, {targetId, now, meta}) {
			const nowSec = Math.floor(now.getTime() / 1000);
			// Precompute the hot-score multiplier in JS so SQL only needs basic
			// arithmetic (SQLite has no POW). `CAST(score * multiplier AS INTEGER)`
			// matches `Math.floor(score * 1000 / (hours+2)^1.8)` for the same
			// inputs — same hot-score formula pano/module.ts uses on submit.
			const hoursOld = Math.max(0, (now.getTime() - meta.createdAtMs) / 3_600_000);
			const hotMultiplier = 1000 / (hoursOld + 2) ** 1.8;
			return [
				env.PHOENIX_DB.prepare(
					`UPDATE post_summary
					 SET score = (SELECT COUNT(*) FROM post_vote WHERE post_id = ?),
						 hot_score = CAST(
							 (SELECT COUNT(*) FROM post_vote WHERE post_id = ?) * ?
							 AS INTEGER
						 ),
						 updated_at = ?,
						 last_activity_at = ?
					 WHERE id = ?`,
				).bind(targetId, targetId, hotMultiplier, nowSec, nowSec, targetId),
			];
		},
	};
}

function commentAdapter(): TargetAdapter {
	return {
		voteTable: "comment_vote",
		voteIdColumn: "comment_id",
		async loadMeta(env, commentId) {
			const db = drizzle(env.PHOENIX_DB, {schema});
			const row = await db.query.commentView.findFirst({
				where: and(eq(schema.commentView.id, commentId), isNull(schema.commentView.deletedAt)),
			});
			if (!row) {
				throw new VoteTargetNotFoundError("comment", commentId);
			}
			return {
				authorId: row.authorId,
				createdAtMs: (row.createdAt ?? new Date()).getTime(),
			};
		},
		scoreCacheStatements(env, {targetId, now}) {
			const nowSec = Math.floor(now.getTime() / 1000);
			return [
				env.PHOENIX_DB.prepare(
					`UPDATE comment_view
					 SET score = (SELECT COUNT(*) FROM comment_vote WHERE comment_id = ?),
						 updated_at = ?
					 WHERE id = ?`,
				).bind(targetId, nowSec, targetId),
			];
		},
	};
}

function adapterFor(kind: VoteTargetKind): TargetAdapter {
	switch (kind) {
		case "definition":
			return definitionAdapter();
		case "post":
			return postAdapter();
		case "comment":
			return commentAdapter();
	}
}

/* -------------------------------------------------------------------------- */
/* Public surface                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Apply a vote (`value: 1`) or a retract (`value: null`) on a target row.
 *
 * The function is idempotent at the `(user_vote.PK)` and the feature-local
 * `(target, voter)` PK: re-casting the same value reports `changed: false`
 * and leaves all caches untouched; retracting when nothing is set is the
 * same no-op. State-changing writes happen inside a single `D1.batch(...)`
 * so the feature-local vote row, the cross-product `user_vote` row, the
 * score cache, and the karma counter move together.
 */
export async function vote(env: Env, input: VoteInput): Promise<VoteResult> {
	const adapter = adapterFor(input.targetKind);
	const meta = await adapter.loadMeta(env, input.targetId);

	const now = new Date();
	const nowSec = Math.floor(now.getTime() / 1000);
	const isCast = input.value === 1;

	// Pre-write probe: does the vote-table row already exist? Drives the
	// `changed` flag without a second round-trip when state matches intent.
	const existing = await env.PHOENIX_DB.prepare(
		`SELECT 1 as ok FROM ${adapter.voteTable}
		 WHERE ${adapter.voteIdColumn} = ? AND voter_id = ? LIMIT 1`,
	)
		.bind(input.targetId, input.userId)
		.first();
	const alreadyCast = existing != null;

	if (isCast === alreadyCast) {
		// Idempotent path: state matches intent, no write. Return the cached
		// score as-is — a cheap indexed point lookup on the target row.
		const score = await readCachedScore(env, input.targetKind, input.targetId);
		return {
			targetKind: input.targetKind,
			targetId: input.targetId,
			score,
			myVote: alreadyCast ? 1 : null,
			changed: false,
		};
	}

	// State change. One batch carries every mutation: the vote-table row
	// (truth source) leads, followed by the score-cache update (which
	// re-counts truth via a `COUNT(*)` subquery in the same statement, so
	// drift from concurrent INSERT OR IGNORE collisions self-heals), the
	// `user_vote` cross-product row, and the karma counter.
	const stmts: D1PreparedStatement[] = [];

	if (isCast) {
		stmts.push(
			env.PHOENIX_DB.prepare(
				`INSERT OR IGNORE INTO ${adapter.voteTable} (${adapter.voteIdColumn}, voter_id, created_at)
				 VALUES (?, ?, ?)`,
			).bind(input.targetId, input.userId, nowSec),
		);
	} else {
		stmts.push(
			env.PHOENIX_DB.prepare(
				`DELETE FROM ${adapter.voteTable} WHERE ${adapter.voteIdColumn} = ? AND voter_id = ?`,
			).bind(input.targetId, input.userId),
		);
	}

	stmts.push(
		...adapter.scoreCacheStatements(env, {
			targetId: input.targetId,
			now,
			meta,
		}),
	);

	if (isCast) {
		stmts.push(
			env.PHOENIX_DB.prepare(
				`INSERT OR IGNORE INTO user_vote (user_id, target_kind, target_id, created_at)
				 VALUES (?, ?, ?, ?)`,
			).bind(input.userId, input.targetKind, input.targetId, nowSec),
		);
		stmts.push(
			env.PHOENIX_DB.prepare(
				`INSERT INTO user_profile (
					user_id, username, display_name, image,
					total_karma, definition_count, post_count, comment_count,
					updated_at, last_event_id
				) VALUES (?, NULL, NULL, NULL, 1, 0, 0, 0, ?, '')
				ON CONFLICT(user_id) DO UPDATE SET
					total_karma = user_profile.total_karma + 1,
					updated_at  = excluded.updated_at`,
			).bind(meta.authorId, nowSec),
		);
	} else {
		stmts.push(
			env.PHOENIX_DB.prepare(
				`DELETE FROM user_vote WHERE user_id = ? AND target_kind = ? AND target_id = ?`,
			).bind(input.userId, input.targetKind, input.targetId),
		);
		stmts.push(
			env.PHOENIX_DB.prepare(
				`UPDATE user_profile SET
					total_karma = MAX(0, total_karma - 1),
					updated_at  = ?
				WHERE user_id = ?`,
			).bind(nowSec, meta.authorId),
		);
	}

	await env.PHOENIX_DB.batch(stmts);

	// Read truth-derived score back from the cache the batch just refreshed.
	// One cheap indexed point lookup; only on the state-change path.
	const newScore = await readCachedScore(env, input.targetKind, input.targetId);

	return {
		targetKind: input.targetKind,
		targetId: input.targetId,
		score: newScore,
		myVote: isCast ? 1 : null,
		changed: true,
	};
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

async function readCachedScore(
	env: Env,
	kind: VoteTargetKind,
	targetId: string,
): Promise<number> {
	const sqlFor = (table: string) =>
		`SELECT score FROM ${table} WHERE id = ? LIMIT 1`;
	const table =
		kind === "definition"
			? "definition_view"
			: kind === "post"
				? "post_summary"
				: "comment_view";
	const row = await env.PHOENIX_DB.prepare(sqlFor(table))
		.bind(targetId)
		.first<{score: number}>();
	return row?.score ?? 0;
}
