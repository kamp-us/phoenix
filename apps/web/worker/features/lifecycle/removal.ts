/**
 * The removal substrate (ADR 0096) — the one seam owning a deletable entity's read
 * projection, write builders, and remove/restore sequence (#1129). An FTS-bearing
 * entity (post) moves its content row and its `post_search` row all-or-none in ONE
 * batch (the ADR 0080 lockstep); the FTS-free kinds are a single update. The FTS items
 * must come from `fts-sync.ts` query-builders — a raw `db.run(sql)` 500s in-batch
 * (#863/#920). Recomputable caches (ADR 0011) still refresh at the call site.
 */
import {eq} from "drizzle-orm";
import {Effect} from "effect";
import type {DrizzleAccessOrDie, DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {TargetKind} from "../../db/target-kind.ts";
import {removePostSearch, syncPostSearch} from "../search/fts-sync.ts";
import type * as Lifecycle from "./EntityLifecycle.ts";

// Re-exported so read + write live behind this one seam (#1129).
export * from "./EntityLifecycle.ts";

const removedSet = (removed: Lifecycle.RemovalColumns, now: Date) =>
	({...removed, score: 0, updatedAt: now}) as const;

const liveSet = (live: Lifecycle.RemovalColumns, now: Date) => ({...live, updatedAt: now}) as const;

const removePostStatements = (
	db: DrizzleDb,
	postId: string,
	removed: Lifecycle.RemovalColumns,
	now: Date,
): readonly [Stmt, Stmt] => [
	db
		.update(schema.postRecord)
		.set({...removedSet(removed, now), hotScore: 0, lastActivityAt: now})
		.where(eq(schema.postRecord.id, postId)),
	removePostSearch(db, postId),
];

/** Votes wiped on removal are not resurrected here (ADR 0096 §4). */
const restorePostStatements = (
	db: DrizzleDb,
	postId: string,
	title: string,
	live: Lifecycle.RemovalColumns,
	now: Date,
): readonly [Stmt, Stmt, Stmt] => [
	db
		.update(schema.postRecord)
		.set({...liveSet(live, now), lastActivityAt: now})
		.where(eq(schema.postRecord.id, postId)),
	...syncPostSearch(db, postId, title),
];

const removeCommentStatement = (
	db: DrizzleDb,
	commentId: string,
	removed: Lifecycle.RemovalColumns,
	now: Date,
) =>
	db
		.update(schema.commentRecord)
		.set(removedSet(removed, now))
		.where(eq(schema.commentRecord.id, commentId));

const restoreCommentStatement = (
	db: DrizzleDb,
	commentId: string,
	live: Lifecycle.RemovalColumns,
	now: Date,
) =>
	db
		.update(schema.commentRecord)
		.set(liveSet(live, now))
		.where(eq(schema.commentRecord.id, commentId));

const removeDefinitionStatement = (
	db: DrizzleDb,
	definitionId: string,
	removed: Lifecycle.RemovalColumns,
	now: Date,
) =>
	db
		.update(schema.definitionRecord)
		.set(removedSet(removed, now))
		.where(eq(schema.definitionRecord.id, definitionId));

const restoreDefinitionStatement = (
	db: DrizzleDb,
	definitionId: string,
	live: Lifecycle.RemovalColumns,
	now: Date,
) =>
	db
		.update(schema.definitionRecord)
		.set(liveSet(live, now))
		.where(eq(schema.definitionRecord.id, definitionId));

/** Passed in by the caller so the sequence never reaches for the `Drizzle`/`Vote` tags itself. */
export interface RemovalSequence {
	readonly run: DrizzleAccessOrDie["run"];
	readonly batch: DrizzleAccessOrDie["batch"];
	readonly clearTarget: (kind: TargetKind, targetId: string) => Effect.Effect<void>;
}

export type RemoveTarget =
	| {readonly kind: "post"; readonly id: string}
	| {readonly kind: "comment"; readonly id: string}
	| {readonly kind: "definition"; readonly id: string};

/** `post` carries the `title` its FTS row is re-indexed from; the FTS-free kinds have none. */
export type RestoreTarget =
	| {readonly kind: "post"; readonly id: string; readonly title: string}
	| {readonly kind: "comment"; readonly id: string}
	| {readonly kind: "definition"; readonly id: string};

/**
 * The vote wipe is its OWN batch (karma KEPT — ADR 0096 §3) and must commit BEFORE the
 * triad stamp + FTS lockstep. Owned here so no call site can wire that order wrong (#1129).
 */
export const removeEntity = (
	seq: RemovalSequence,
	target: RemoveTarget,
	removed: Lifecycle.RemovalColumns,
	now: Date,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* seq.clearTarget(target.kind, target.id);
		switch (target.kind) {
			case "post":
				yield* seq.batch((db) => removePostStatements(db, target.id, removed, now));
				return;
			case "comment":
				yield* seq.run((db) => removeCommentStatement(db, target.id, removed, now));
				return;
			case "definition":
				yield* seq.run((db) => removeDefinitionStatement(db, target.id, removed, now));
				return;
		}
	});

/** No vote wipe on this side: votes cleared on removal are not resurrected (ADR 0096 §4). */
export const restoreEntity = (
	seq: RemovalSequence,
	target: RestoreTarget,
	live: Lifecycle.RemovalColumns,
	now: Date,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		switch (target.kind) {
			case "post":
				yield* seq.batch((db) => restorePostStatements(db, target.id, target.title, live, now));
				return;
			case "comment":
				yield* seq.run((db) => restoreCommentStatement(db, target.id, live, now));
				return;
			case "definition":
				yield* seq.run((db) => restoreDefinitionStatement(db, target.id, live, now));
				return;
		}
	});
