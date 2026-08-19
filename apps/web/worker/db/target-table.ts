/**
 * The per-{@link TargetKind} target-table descriptor the vote/report engines dispatch
 * through, so the `definition | post | comment` fan-out lives once here instead of a
 * hand-written `switch (kind)` at every call site (#1125).
 *
 * Sits in `db/` because the `vote/`↔`report/` boundary pins forbid a sibling-feature edge yet
 * Vote, Report and the schema all key off this one taxonomy. It names only db primitives, so
 * a service-level fan-out is a different seam and stays out of here.
 */
import {and, eq, exists, notExists, type SQL, sql} from "drizzle-orm";
import type {DrizzleDb, Stmt} from "./Drizzle.ts";
import * as schema from "./drizzle/schema.ts";
import {hotMultiplier} from "./hotScore.ts";
import type {TargetKind} from "./target-kind.ts";

export interface TargetRecordMeta {
	authorId: string;
	createdAtMs: number;
	/**
	 * Is the target a still-sandboxed çaylak item? The eligibility split `Vote.cast` reads: an
	 * ordinary cast rejects a sandboxed target; only the divan-gated `castOnSandboxed` accepts
	 * one (#1288).
	 */
	sandboxed: boolean;
}

export interface TargetTableDescriptor {
	readonly loadMeta: (db: DrizzleDb, targetId: string) => Promise<TargetRecordMeta | null>;
	readonly probeVote: (db: DrizzleDb, targetId: string, voterId: string) => Promise<boolean>;
	/**
	 * An `SQL` predicate true iff the vote write will actually change the row's presence.
	 * Threaded into the karma bump + ledger statements and ordered ahead of the vote-row
	 * write, so it reads PRE-mutation state: a duplicate concurrent cast finds the row already
	 * present (or already gone on a retract) and applies the karma delta zero times (#2552).
	 * The in-batch backstop the out-of-batch `probeVote` fast-path can race past.
	 */
	readonly voteChangeGuard: (
		db: DrizzleDb,
		targetId: string,
		voterId: string,
		isCast: boolean,
	) => SQL;
	readonly readScore: (db: DrizzleDb, targetId: string) => Promise<number>;
	readonly voteInsert: (db: DrizzleDb, targetId: string, voterId: string, now: Date) => Stmt;
	readonly voteDelete: (db: DrizzleDb, targetId: string, voterId: string) => Stmt;
	readonly clearVotes: (db: DrizzleDb, targetId: string) => Stmt;
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
		voteChangeGuard: (db, targetId, voterId, isCast) => {
			const probe = db
				.select({one: sql`1`})
				.from(schema.definitionVote)
				.where(
					and(
						eq(schema.definitionVote.definitionId, targetId),
						eq(schema.definitionVote.voterId, voterId),
					),
				);
			return isCast ? notExists(probe) : exists(probe);
		},
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
		scoreCache: (db, targetId) =>
			db
				.update(schema.definitionRecord)
				.set({
					score: sql`(SELECT COUNT(*) FROM ${schema.definitionVote} WHERE ${schema.definitionVote.definitionId} = ${targetId})`,
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
		voteChangeGuard: (db, targetId, voterId, isCast) => {
			const probe = db
				.select({one: sql`1`})
				.from(schema.postVote)
				.where(and(eq(schema.postVote.postId, targetId), eq(schema.postVote.voterId, voterId)));
			return isCast ? notExists(probe) : exists(probe);
		},
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
					// A vote refreshes activity-ordering (`lastActivityAt`) but is NOT a
					// content edit, so it must not touch `updatedAt` (the badge; #1634).
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
		voteChangeGuard: (db, targetId, voterId, isCast) => {
			const probe = db
				.select({one: sql`1`})
				.from(schema.commentVote)
				.where(
					and(eq(schema.commentVote.commentId, targetId), eq(schema.commentVote.voterId, voterId)),
				);
			return isCast ? notExists(probe) : exists(probe);
		},
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
		scoreCache: (db, targetId) =>
			db
				.update(schema.commentRecord)
				.set({
					score: sql`(SELECT COUNT(*) FROM ${schema.commentVote} WHERE ${schema.commentVote.commentId} = ${targetId})`,
				})
				.where(eq(schema.commentRecord.id, targetId)),
	},
};
