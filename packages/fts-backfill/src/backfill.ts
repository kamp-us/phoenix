/**
 * The FTS backfill core (issue #534): re-index the existing `term_summary` /
 * `post_summary` rows into the FTS5 `term_search` / `post_search` tables by
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
 * Posts are filtered to live (`deleted_at IS NULL`) rows — the search resolver
 * only hydrates non-deleted posts and the dual-write removes a deleted post's
 * FTS row, so a deleted post must not be searchable.
 */
import {syncPostSearch, syncTermSearch} from "@kampus/web/features/search/fts-sync";
import type {SQL} from "drizzle-orm";
import {isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {SQLiteAsyncDialect} from "drizzle-orm/sqlite-core";
import {backfillSchema, postSummary, termSummary} from "./schema.ts";

const dialect = new SQLiteAsyncDialect();

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
	terms: ReadonlyArray<SourceRow>,
	posts: ReadonlyArray<SourceRow>,
): {statements: SQL[]; report: BackfillReport} => {
	const termStmts = terms.flatMap((row) => syncTermSearch(row.key, row.title));
	const postStmts = posts.flatMap((row) => syncPostSearch(row.key, row.title));
	return {
		statements: [...termStmts, ...postStmts],
		report: {terms: terms.length, posts: posts.length},
	};
};

/**
 * Read every term + every live post from D1, then write their FTS rows as one
 * atomic, idempotent batch. Returns the row counts indexed. An empty corpus is a
 * clean no-op (the empty case returns before any write).
 *
 * The write goes over the raw D1 batch contract (`prepare(sql).bind(...params)`
 * per statement, then one `D1Database.batch([...])`) rather than drizzle's
 * `db.batch([db.run(sql)...])`: a raw `db.run(SQL)` builds a `SQLiteRaw` whose
 * `_prepare()` returns itself with no `.stmt`, so drizzle's d1 batch loop throws
 * reading `preparedQuery.stmt.bind` (drizzle 1.0.0-rc.3; see issue #893).
 * `D1Database.batch` is itself atomic, so the all-or-none guarantee is preserved.
 */
export const backfill = async (d1: D1Database): Promise<BackfillReport> => {
	const db = makeBackfillDb(d1);

	const termRows = await db
		.select({key: termSummary.slug, title: termSummary.title})
		.from(termSummary);
	const postRows = await db
		.select({key: postSummary.id, title: postSummary.title})
		.from(postSummary)
		.where(isNull(postSummary.deletedAt));

	const {statements, report} = buildBackfillStatements(termRows, postRows);
	if (statements.length === 0) return report;

	const bound = statements.map((stmt) => {
		const {sql, params} = dialect.sqlToQuery(stmt);
		return d1.prepare(sql).bind(...params);
	});
	await d1.batch(bound);
	return report;
};
