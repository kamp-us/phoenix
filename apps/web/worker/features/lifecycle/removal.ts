/**
 * The removal substrate (ADR 0096) — the ONE seam owning a deletable entity's full
 * lifecycle: its read projection, its write builders, and the remove/restore
 * *sequence* (#1129). The read side (`EntityLifecycle` projection + `RemovalReason`
 * codec) is authored in `EntityLifecycle.ts` and re-exported below so a call site
 * reaches read + write through this one module, never a column-by-column split.
 *
 * The write builders own the statement lockstep a removal/restore holds (ADR 0080):
 * stamp the `removed_at`/`removed_by`/`removed_reason` triad onto the content row
 * AND move its FTS row all-or-none in ONE `Drizzle.batch`.
 *
 * Two entity shapes:
 *   - **FTS-bearing** (post): the summary row and its `post_search` row move
 *     together, so a remove/restore is a TWO-statement batch (stamp + FTS) — the
 *     lockstep ADR 0080 stakes the design on. The FTS items come from
 *     `fts-sync.ts` (never reinvented): drizzle query-builders that `_prepare()`
 *     to a bound D1 `.stmt` the batch driver binds — a raw `db.run(sql)` 500s
 *     in-batch (#863/#920), so the builders stay query-builder-shaped.
 *   - **FTS-free** (definition, comment): no search row, so a remove/restore is a
 *     SINGLE `update` — the same triad stamp, no batch.
 *
 * The full SEQUENCE is owned by {@link removeEntity}/{@link restoreEntity}: the vote
 * wipe (`Vote.clearTarget`, karma KEPT — ADR 0096 §3) is its OWN atomic batch in
 * `Vote.ts`, committed BEFORE the stamp (it was never one batch with the stamp), then
 * the triad-stamp + FTS lockstep. Callers pass intent; the ordering can no longer be
 * hand-wired wrong. The recomputable caches (score/hot/commentCount/stats, ADR 0011)
 * the caller still refreshes outside.
 */
import {eq} from "drizzle-orm";
import {Effect} from "effect";
import type {DrizzleAccessOrDie, DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {TargetKind} from "../../db/target-kind.ts";
import {removePostSearch, syncPostSearch} from "../search/fts-sync.ts";
import type * as Lifecycle from "./EntityLifecycle.ts";

// The removal read projection (ADR 0096 §2) is authored in `EntityLifecycle.ts` and
// re-exported so read + write live behind this one seam (#1129): `EntityLifecycle`,
// `RemovalColumns`, `fromColumns`/`toColumns`, `remove`/`restore`, the `RemovalReason`
// codec, `isRemoved`/`isLive`, and the reason labels. Its own unit tests still target
// `EntityLifecycle.ts` directly; this module is the consolidated front door.
export * from "./EntityLifecycle.ts";

/** The removed triad + score-zeroing every record table shares on a removal stamp. */
const removedSet = (removed: Lifecycle.RemovalColumns, now: Date) =>
	({...removed, score: 0, updatedAt: now}) as const;

/** The cleared triad + bumped `updatedAt` every record table shares on a restore. */
const liveSet = (live: Lifecycle.RemovalColumns, now: Date) => ({...live, updatedAt: now}) as const;

/**
 * The post remove batch: stamp the `Removed` triad + zero score/hot, and drop the
 * `post_search` row — ONE all-or-none batch (ADR 0080 lockstep). Votes are cleared
 * by {@link removeEntity}'s `clearTarget` (its own batch) before this.
 */
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

/**
 * The post restore batch: clear the triad and re-enter the `post_search` row from
 * the title — ONE all-or-none batch (ADR 0080 lockstep). Votes wiped on removal
 * are not resurrected (ADR 0096 §4).
 */
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

/** The comment remove update (FTS-free): stamp the triad + zero score. */
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

/** The comment restore update (FTS-free): clear the triad. */
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

/** The definition remove update (FTS-free): stamp the triad + zero score. */
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

/** The definition restore update (FTS-free): clear the triad. */
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

/**
 * The drizzle write handles + the vote-wipe the sequence owner drives. A service
 * passes its own `{run, batch}` ({@link DrizzleAccessOrDie}) and `Vote.clearTarget`
 * so the sequence runs inside the caller's wiring without {@link removeEntity}
 * reaching for the `Drizzle`/`Vote` tags itself (the per-feature stat/cache refresh
 * stays at the call site).
 */
export interface RemovalSequence {
	readonly run: DrizzleAccessOrDie["run"];
	readonly batch: DrizzleAccessOrDie["batch"];
	readonly clearTarget: (kind: TargetKind, targetId: string) => Effect.Effect<void>;
}

/**
 * Remove intent, tagged by entity kind. The kind selects both the vote-target kind
 * and the write shape (post = stamp+FTS batch; comment/definition = single update);
 * an invalid kind/data pairing is unrepresentable.
 */
export type RemoveTarget =
	| {readonly kind: "post"; readonly id: string}
	| {readonly kind: "comment"; readonly id: string}
	| {readonly kind: "definition"; readonly id: string};

/**
 * Restore intent, tagged by entity kind. `post` carries the `title` its FTS row is
 * re-indexed from; the FTS-free kinds don't, so a title-less post restore — or a
 * title on a comment/definition restore — does not typecheck.
 */
export type RestoreTarget =
	| {readonly kind: "post"; readonly id: string; readonly title: string}
	| {readonly kind: "comment"; readonly id: string}
	| {readonly kind: "definition"; readonly id: string};

/**
 * The full remove SEQUENCE, single-owned (#1129): the vote wipe (its OWN batch, karma
 * KEPT — ADR 0096 §3) committed BEFORE the triad stamp + FTS lockstep (ADR 0080). A
 * call site passes the `removed` columns it stamped from `Lifecycle.remove(...)`; it
 * cannot get the vote-wipe→stamp ordering or the batch boundaries wrong because they
 * are not its to wire. Stats/caches refresh at the call site, after.
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

/**
 * The full restore SEQUENCE, single-owned (#1129): clear the triad (post = stamp+FTS
 * batch, FTS re-entered from `title`; comment/definition = single update). No vote
 * wipe — votes cleared on removal are not resurrected (ADR 0096 §4). The `live`
 * columns come from `Lifecycle.restore(...)` at the call site; stats refresh after.
 */
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
