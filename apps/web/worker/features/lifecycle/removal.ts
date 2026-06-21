/**
 * Write-side of the removal substrate (ADR 0096) — the orchestration twin of the
 * read-side projection in `EntityLifecycle.ts`. One place owns the statement
 * lockstep a removal/restore holds (ADR 0080): stamp the `removed_at`/
 * `removed_by`/`removed_reason` triad onto the content row AND move its FTS row
 * all-or-none in ONE `Drizzle.batch`. Call sites spread these builders into their
 * batch instead of re-inlining the lockstep behind a repeated `ADR 0080 lockstep`
 * comment — a substrate-column or FTS-rule change is now a one-module edit.
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
 * The vote wipe (`Vote.clearTarget`, karma KEPT — ADR 0096 §3) is its OWN atomic
 * batch in `Vote.ts`, committed by the caller BEFORE the stamp; it is not folded
 * in here (it was never one batch with the stamp). The recomputable caches
 * (score/hot/commentCount/stats, ADR 0011) the caller still refreshes outside.
 */
import {eq} from "drizzle-orm";
import type {DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {removePostSearch, syncPostSearch} from "../search/fts-sync.ts";
import type * as Lifecycle from "./EntityLifecycle.ts";

/** The removed triad + score-zeroing every record table shares on a removal stamp. */
const removedSet = (removed: Lifecycle.RemovalColumns, now: Date) =>
	({...removed, score: 0, updatedAt: now}) as const;

/** The cleared triad + bumped `updatedAt` every record table shares on a restore. */
const liveSet = (live: Lifecycle.RemovalColumns, now: Date) => ({...live, updatedAt: now}) as const;

/**
 * The post remove batch: stamp the `Removed` triad + zero score/hot, and drop the
 * `post_search` row — ONE all-or-none batch (ADR 0080 lockstep). Votes are cleared
 * by the caller's `clearTarget` (its own batch) before this.
 */
export const removePostStatements = (
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
export const restorePostStatements = (
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
export const removeCommentStatement = (
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
export const restoreCommentStatement = (
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
export const removeDefinitionStatement = (
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
export const restoreDefinitionStatement = (
	db: DrizzleDb,
	definitionId: string,
	live: Lifecycle.RemovalColumns,
	now: Date,
) =>
	db
		.update(schema.definitionRecord)
		.set(liveSet(live, now))
		.where(eq(schema.definitionRecord.id, definitionId));
