/**
 * The FTS backfill core (issue #534): re-index the existing `term_record` /
 * `post_record` rows into the FTS5 `term_search` / `post_search` tables by
 * replaying the ADR-0080 dual-write sync over every source row.
 *
 * Root cause it fixes: the FTS tables are populated ONLY by the application
 * dual-write on new writes (`syncTermSearch` / `syncPostSearch`, ADR 0080) —
 * rows written before that sync existed in the summary tables but were never
 * indexed, so search returns empty for all pre-existing content. This is the
 * one-time backfill CLAUDE.md's "Sözlük seed" section mandates: a direct-D1
 * script, not a worker route, not a `.sql` migration (a migration can't run the
 * app-side Turkish fold the FTS `norm` column needs).
 *
 * Reuses the worker's OWN sync builders (`@kampus/web/features/search/fts-sync`),
 * NOT a reimplementation — so the indexed `norm` is byte-identical to the
 * dual-write's (issue #534's hard constraint: identical normalization, or the
 * backfilled rows won't match queries). Each builder is a delete-then-insert
 * upsert keyed on slug/id, so the backfill is idempotent: re-running it replaces
 * the same FTS rows rather than duplicating them.
 *
 * Posts are filtered to live (`removed_at IS NULL`) rows — the search resolver
 * only hydrates non-removed posts and the dual-write removes a removed post's
 * FTS row, so a removed post must not be searchable.
 */
import type {FtsSyncDb, Stmt} from "@kampus/web/db/Drizzle";
import {syncPostSearch, syncTermSearch} from "@kampus/web/features/search/fts-sync";
import {isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {backfillSchema, postRecord, termRecord} from "./schema.ts";

export type BackfillDb = ReturnType<typeof drizzle<typeof backfillSchema>>;

export const makeBackfillDb = (d1: D1Database): BackfillDb => drizzle(d1, {schema: backfillSchema});

/** One source row to index: the FTS key (slug/id) and the title indexed into `norm`. */
export interface SourceRow {
	readonly key: string;
	readonly title: string;
}

/** How many FTS rows of each kind the backfill (re-)indexed — surfaced by the bin for a legible log. */
export interface BackfillReport {
	readonly terms: number;
	readonly posts: number;
}

/**
 * Build the flat list of FTS upsert statements for the given source rows, reusing
 * the worker's `syncTermSearch` / `syncPostSearch` (each a `[DELETE, INSERT]`
 * pair). Pure of I/O and of the read — the bin passes the rows it fetched, the
 * unit test passes fixtures — so the statement set is asserted with no database.
 */
export const buildBackfillStatements = (
	db: FtsSyncDb,
	terms: ReadonlyArray<SourceRow>,
	posts: ReadonlyArray<SourceRow>,
): {statements: Stmt[]; report: BackfillReport} => {
	const termStmts = terms.flatMap((row) => syncTermSearch(db, row.key, row.title));
	const postStmts = posts.flatMap((row) => syncPostSearch(db, row.key, row.title));
	return {
		statements: [...termStmts, ...postStmts],
		report: {terms: terms.length, posts: posts.length},
	};
};

/**
 * Read every term + every live post from D1, then write their FTS rows as one
 * atomic, idempotent batch through the ADR-0080 sync builders. Returns the row
 * counts indexed. An empty corpus is a clean no-op (D1 `batch` rejects an empty
 * tuple, so the empty case returns without a write).
 */
export const backfill = async (d1: D1Database): Promise<BackfillReport> => {
	const db = makeBackfillDb(d1);

	const termRows = await db
		.select({key: termRecord.slug, title: termRecord.title})
		.from(termRecord);
	const postRows = await db
		.select({key: postRecord.id, title: postRecord.title})
		.from(postRecord)
		.where(isNull(postRecord.removedAt));

	const {statements, report} = buildBackfillStatements(db, termRows, postRows);

	// The statements are ALREADY batch-able drizzle builders (ADR 0080 / #863) —
	// batch them directly. Wrapping each back through `db.run` would yield a
	// `SQLiteRaw` with no bound `.stmt` and 500 the batch: the exact #863 defect.
	const [first, ...rest] = statements;
	if (first === undefined) return report;
	await db.batch([first, ...rest]);
	return report;
};
