/**
 * The per-{@link TargetKind} **target-table descriptor** — the one structure the
 * vote/report engines dispatch through, so the `definition | post | comment`
 * fan-out lives once here instead of as a hand-written `switch (kind)` re-stated
 * at every call site. Each descriptor closes over the kind's own typed drizzle
 * tables/columns, so its bodies stay type-correct while the call sites collapse
 * to `targetTable[kind].<op>(…)`. (Issue #1125 — locality.)
 *
 * Sits in `db/` beside {@link ./target-kind.ts} — below both feature directories —
 * because the `vote/`↔`report/` boundary pins forbid a sibling-feature edge yet
 * Vote and Report (and the schema) all key off this one taxonomy. The descriptor
 * names only db primitives (`DrizzleDb`, drizzle tables, `Stmt`); it knows
 * nothing of the feature services, so a `report/mutations.ts` *service* fan-out
 * (Sözlük/Pano) is a different seam and stays out of here.
 */
import {and, eq, sql} from "drizzle-orm";
import type {DrizzleDb, Stmt} from "./Drizzle.ts";
import * as schema from "./drizzle/schema.ts";
import {hotMultiplier} from "./hotScore.ts";
import type {TargetKind} from "./target-kind.ts";

/** The author + creation instant a vote needs before its write (karma recipient + hot-score age). */
export interface TargetRecordMeta {
	authorId: string;
	createdAtMs: number;
	/**
	 * Is the target a still-sandboxed (`sandboxed_at IS NOT NULL`) çaylak item? The
	 * eligibility split `Vote.cast` reads: the ordinary cast rejects a sandboxed target
	 * ({@link ./../features/vote/errors.ts VoteTargetSandboxed}); only the divan-gated
	 * `castOnSandboxed` accepts one (#1288). Live content reads `false`.
	 */
	sandboxed: boolean;
}

/**
 * One kind's vote/report table operations. Every method takes the live `db` plus
 * the row keys it needs and returns either an awaited query (`probeVote`,
 * `readScore`, `loadMeta`) or an unexecuted `Stmt` for the atomic batch
 * (`voteInsert`/`voteDelete`/`clearVotes`/`scoreCache`). Behaviour is identical to
 * the switch arms it replaces — same tables, same columns, same SQL.
 */
export interface TargetTableDescriptor {
	/**
	 * Live-record lookup (`removed_at IS NULL`) returning the karma recipient + age,
	 * or `null` when the target is missing or soft-removed. Backs Vote.loadMeta and
	 * Report.assertTargetLive.
	 */
	readonly loadMeta: (db: DrizzleDb, targetId: string) => Promise<TargetRecordMeta | null>;
	/** Vote-presence point lookup on `(targetId, voterId)` — the idempotency probe. */
	readonly probeVote: (db: DrizzleDb, targetId: string, voterId: string) => Promise<boolean>;
	/** The truth-derived score cached on the record row (0 when the row is gone). */
	readonly readScore: (db: DrizzleDb, targetId: string) => Promise<number>;
	/** Insert the per-target vote row (idempotent on the PK). */
	readonly voteInsert: (db: DrizzleDb, targetId: string, voterId: string, now: Date) => Stmt;
	/** Delete the per-target vote row for `(targetId, voterId)`. */
	readonly voteDelete: (db: DrizzleDb, targetId: string, voterId: string) => Stmt;
	/** Delete every per-target vote row for the target (the removal-substrate wipe). */
	readonly clearVotes: (db: DrizzleDb, targetId: string) => Stmt;
	/**
	 * Refresh the record's cached `score` (and, for posts, `hot_score`) from a
	 * `COUNT(*)` over the truth-source vote table, inside the same batch as the
	 * vote write.
	 */
	readonly scoreCache: (db: DrizzleDb, targetId: string, now: Date, meta: TargetRecordMeta) => Stmt;
}

const metaOf = (row: {
	authorId: string;
	createdAt: Date | null;
	sandboxedAt: Date | null;
}): TargetRecordMeta => ({
	authorId: row.authorId,
	createdAtMs: (row.createdAt ?? new Date()).getTime(),
	sandboxed: row.sandboxedAt != null,
});

/**
 * The taxonomy's behaviour, keyed once. Each entry closes over its kind's typed
 * tables; the shared method shape is what lets the generic call sites in
 * Vote/Report dispatch against any `TargetKind`.
 */
export const targetTable: {readonly [K in TargetKind]: TargetTableDescriptor} = {
	definition: {
		loadMeta: (db, targetId) =>
			db.query.definitionRecord
				.findFirst({where: {id: targetId, removedAt: {isNull: true}}})
				.then((row) => (row ? metaOf(row) : null)),
		probeVote: (db, targetId, voterId) =>
			db.query.definitionVote
				.findFirst({where: {definitionId: targetId, voterId}})
				.then((row) => row != null),
		readScore: (db, targetId) =>
			db.query.definitionRecord
				.findFirst({where: {id: targetId}, columns: {score: true}})
				.then((row) => row?.score ?? 0),
		voteInsert: (db, targetId, voterId, now) =>
			db
				.insert(schema.definitionVote)
				.values({definitionId: targetId, voterId, createdAt: now})
				.onConflictDoNothing(),
		voteDelete: (db, targetId, voterId) =>
			db
				.delete(schema.definitionVote)
				.where(
					and(
						eq(schema.definitionVote.definitionId, targetId),
						eq(schema.definitionVote.voterId, voterId),
					),
				),
		clearVotes: (db, targetId) =>
			db.delete(schema.definitionVote).where(eq(schema.definitionVote.definitionId, targetId)),
		scoreCache: (db, targetId, now) =>
			db
				.update(schema.definitionRecord)
				.set({
					score: sql`(SELECT COUNT(*) FROM ${schema.definitionVote} WHERE ${schema.definitionVote.definitionId} = ${targetId})`,
					updatedAt: now,
				})
				.where(eq(schema.definitionRecord.id, targetId)),
	},
	post: {
		loadMeta: (db, targetId) =>
			db.query.postRecord
				.findFirst({where: {id: targetId, removedAt: {isNull: true}}})
				.then((row) => (row ? metaOf(row) : null)),
		probeVote: (db, targetId, voterId) =>
			db.query.postVote.findFirst({where: {postId: targetId, voterId}}).then((row) => row != null),
		readScore: (db, targetId) =>
			db.query.postRecord
				.findFirst({where: {id: targetId}, columns: {score: true}})
				.then((row) => row?.score ?? 0),
		voteInsert: (db, targetId, voterId, now) =>
			db
				.insert(schema.postVote)
				.values({postId: targetId, voterId, createdAt: now})
				.onConflictDoNothing(),
		voteDelete: (db, targetId, voterId) =>
			db
				.delete(schema.postVote)
				.where(and(eq(schema.postVote.postId, targetId), eq(schema.postVote.voterId, voterId))),
		clearVotes: (db, targetId) =>
			db.delete(schema.postVote).where(eq(schema.postVote.postId, targetId)),
		// Posts also carry a precomputed `hot_score`. SQLite has no `POW`, so the
		// multiplier is computed in JS and bound into the recompute (as before).
		scoreCache: (db, targetId, now, meta) => {
			const multiplier = hotMultiplier(meta.createdAtMs, now.getTime());
			return db
				.update(schema.postRecord)
				.set({
					score: sql`(SELECT COUNT(*) FROM ${schema.postVote} WHERE ${schema.postVote.postId} = ${targetId})`,
					hotScore: sql`CAST((SELECT COUNT(*) FROM ${schema.postVote} WHERE ${schema.postVote.postId} = ${targetId}) * ${multiplier} AS INTEGER)`,
					updatedAt: now,
					lastActivityAt: now,
				})
				.where(eq(schema.postRecord.id, targetId));
		},
	},
	comment: {
		loadMeta: (db, targetId) =>
			db.query.commentRecord
				.findFirst({where: {id: targetId, removedAt: {isNull: true}}})
				.then((row) => (row ? metaOf(row) : null)),
		probeVote: (db, targetId, voterId) =>
			db.query.commentVote
				.findFirst({where: {commentId: targetId, voterId}})
				.then((row) => row != null),
		readScore: (db, targetId) =>
			db.query.commentRecord
				.findFirst({where: {id: targetId}, columns: {score: true}})
				.then((row) => row?.score ?? 0),
		voteInsert: (db, targetId, voterId, now) =>
			db
				.insert(schema.commentVote)
				.values({commentId: targetId, voterId, createdAt: now})
				.onConflictDoNothing(),
		voteDelete: (db, targetId, voterId) =>
			db
				.delete(schema.commentVote)
				.where(
					and(eq(schema.commentVote.commentId, targetId), eq(schema.commentVote.voterId, voterId)),
				),
		clearVotes: (db, targetId) =>
			db.delete(schema.commentVote).where(eq(schema.commentVote.commentId, targetId)),
		scoreCache: (db, targetId, now) =>
			db
				.update(schema.commentRecord)
				.set({
					score: sql`(SELECT COUNT(*) FROM ${schema.commentVote} WHERE ${schema.commentVote.commentId} = ${targetId})`,
					updatedAt: now,
				})
				.where(eq(schema.commentRecord.id, targetId)),
	},
};
