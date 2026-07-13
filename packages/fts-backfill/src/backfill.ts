/**
 * The FTS backfill core (#534): re-index existing `term_record` / `post_record`
 * rows into the FTS5 `term_search` / `post_search` tables by replaying the
 * ADR-0080 dual-write over every source row — the one-time backfill CLAUDE.md's
 * "Sözlük seed" section mandates (a direct-D1 script, not a route/migration).
 *
 * Reuses the worker's OWN sync builders (`@kampus/web/features/search/fts-sync`),
 * so the indexed `norm` is byte-identical to the dual-write's — #534's hard
 * constraint: identical normalization, or backfilled rows won't match queries.
 * The builders are delete-then-insert upserts keyed on slug/id, so the backfill
 * is idempotent.
 *
 * Posts are filtered to live (`removed_at IS NULL`) rows: the dual-write removes
 * a removed post's FTS row, so a removed post must not be searchable.
 */
import type {FtsSyncDb, Stmt} from "@kampus/web/db/Drizzle";
import {syncPostSearch, syncTermSearch} from "@kampus/web/features/search/fts-sync";
import {isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {defineRelations} from "drizzle-orm/relations";
import {backfillSchema, postRecord, termRecord} from "./schema.ts";

// RQB v2 (drizzle 1.0): drizzle() takes `relations`, not `schema` (ADR: #727). The
// backfill runs no relational `.with` traversal, so empty `defineRelations(backfillSchema)`
// just registers the tables — mirrors apps/web worker/db/Drizzle.ts.
const relations = defineRelations(backfillSchema);

export type BackfillDb = ReturnType<typeof drizzle<typeof relations>>;

export const makeBackfillDb = (d1: D1Database): BackfillDb => drizzle(d1, {relations});

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
