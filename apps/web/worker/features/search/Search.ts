/**
 * Search — the lexical site-search service (ADR 0080). Owns the FTS5 read path:
 * a bm25-ranked, keyset-paginated MATCH over the `term_search` / `post_search`
 * virtual tables, joined back to `term_summary` / `post_summary` for the row
 * shape the existing `Term` / `Post` views already render.
 *
 * Scope v1 is term titles + post titles (ADR 0080); definition/comment bodies and
 * users are deferred. The write-side sync that keeps the FTS tables current lives
 * in `fts-sync.ts`, called from the Sozluk/Pano mutation handlers (dual-write, not
 * triggers).
 *
 * Pagination keyset: `(bm25 rank asc, key asc)` — bm25 returns more-negative for a
 * better match, so ascending rank IS relevance-first (ADR 0019 keyset shape, with
 * the FTS rank as the lead column and the slug/id as the stable tiebreaker). The
 * cursor is the row key; an `after` whose key no longer matches the query is a
 * cursor miss → empty page (the shared connection semantic).
 */

import {sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {forwardPage, resolveCursor} from "../../db/keyset.ts";
import type {PostSummaryRow} from "../pano/Pano.ts";
import {type TermSummaryRow, termSummaryColumns, toTermSummaryRow} from "../sozluk/term-summary.ts";
import {toMatchExpression} from "./normalize.ts";

const DEFAULT_FIRST = 20;
const MAX_FIRST = 100;

const clampFirst = (first?: number): number =>
	Math.max(1, Math.min(first ?? DEFAULT_FIRST, MAX_FIRST));

export interface SearchPage<Row> {
	rows: Row[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

export type TermSearchPage = SearchPage<TermSummaryRow>;
export type PostSearchPage = SearchPage<PostSummaryRow>;

const emptyPage = <Row>(): SearchPage<Row> => ({
	rows: [],
	hasNextPage: false,
	endCursor: null,
	totalCount: 0,
});

export interface SearchOpts {
	query: string;
	first?: number | undefined;
	after?: string | null | undefined;
}

export class Search extends Context.Service<
	Search,
	{
		/**
		 * bm25-ranked keyset page of term-title matches. Returns full
		 * `TermSummaryRow`s so the resolver reuses the `Term` shaper. A query below
		 * the min length (or matching nothing) yields an empty connection.
		 */
		readonly searchTerms: (opts: SearchOpts) => Effect.Effect<TermSearchPage>;

		/** bm25-ranked keyset page of post-title matches (full `PostSummaryRow`s). */
		readonly searchPosts: (opts: SearchOpts) => Effect.Effect<PostSearchPage>;
	}
>()("@kampus/search/Search") {}

/**
 * Resolve the cursor row's bm25 rank for the same MATCH (bm25 is stable for a
 * given doc + query), so the keyset predicate selects rows strictly after it. A
 * key that no longer matches is a cursor miss → `null` (caller returns empty).
 */
const resolveCursorRank = async (
	db: DrizzleDb,
	ftsTable: string,
	keyColumn: string,
	match: string,
	key: string,
): Promise<number | null> => {
	const row = await db
		.run(
			sql`SELECT bm25(${sql.raw(ftsTable)}) AS rank FROM ${sql.raw(ftsTable)} WHERE ${sql.raw(ftsTable)} MATCH ${match} AND ${sql.raw(keyColumn)} = ${key}`,
		)
		.then((r) => r.results[0] as {rank: number} | undefined);
	return row?.rank ?? null;
};

/**
 * The shared FTS read: count matches, resolve the cursor (if any), then fetch the
 * keyed page ordered `(bm25 asc, key asc)`. Returns the ranked list of keys + the
 * `hasNextPage`/`endCursor` envelope; the caller hydrates rows from the summary
 * table (keeping summary-row shaping in one place per domain).
 */
const ftsKeysetKeys = async (
	db: DrizzleDb,
	ftsTable: string,
	keyColumn: string,
	opts: {match: string; first: number; after: string | null},
): Promise<{
	keys: string[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}> => {
	const {match, first, after} = opts;

	const totalCount = await db
		.run(
			sql`SELECT count(*) AS n FROM ${sql.raw(ftsTable)} WHERE ${sql.raw(ftsTable)} MATCH ${match}`,
		)
		.then((r) => Number((r.results[0] as {n: number} | undefined)?.n ?? 0));

	// The DB read (resolveCursorRank) is the port; `resolveCursor` is the pure
	// cursor-miss decision (ADR 0082). bm25 rank `0` is a valid hit, not a miss.
	const cursor = resolveCursor<number>(
		after,
		after ? await resolveCursorRank(db, ftsTable, keyColumn, match, after) : null,
	);
	if (cursor.kind === "miss") {
		return {keys: [], hasNextPage: false, endCursor: null, totalCount};
	}
	const cursorRank = cursor.kind === "hit" ? cursor.row : null;

	// `(rank asc, key asc)` strictly-after predicate. bm25() can't be referenced by
	// its SELECT alias in WHERE, so it's re-spelled inline.
	const rankExpr = sql`bm25(${sql.raw(ftsTable)})`;
	const after_ =
		cursorRank !== null
			? sql` AND (${rankExpr} > ${cursorRank} OR (${rankExpr} = ${cursorRank} AND ${sql.raw(keyColumn)} > ${after}))`
			: sql``;

	const fetched = await db
		.run(
			sql`SELECT ${sql.raw(keyColumn)} AS key FROM ${sql.raw(ftsTable)} WHERE ${sql.raw(ftsTable)} MATCH ${match}${after_} ORDER BY ${rankExpr} ASC, ${sql.raw(keyColumn)} ASC LIMIT ${first + 1}`,
		)
		.then((r) => (r.results as Array<{key: string}>).map((row) => row.key));

	const page = forwardPage(fetched, first, (key: string) => key);
	return {keys: page.rows, hasNextPage: page.hasNextPage, endCursor: page.endCursor, totalCount};
};

export const SearchLive = Layer.effect(Search)(
	Effect.gen(function* () {
		const {run} = orDieAccess(yield* Drizzle);

		const searchTerms = Effect.fn("Search.searchTerms")(function* (opts: SearchOpts) {
			const match = toMatchExpression(opts.query);
			if (match === null) return emptyPage<TermSummaryRow>();

			const first = clampFirst(opts.first);
			const after = opts.after ?? null;

			const {keys, hasNextPage, endCursor, totalCount} = yield* run((db) =>
				ftsKeysetKeys(db, "term_search", "slug", {match, first, after}),
			);
			if (keys.length === 0) {
				return {rows: [], hasNextPage, endCursor, totalCount} satisfies TermSearchPage;
			}

			// Hydrate summary rows, then re-order to the FTS rank order (a keyed
			// `IN (...)` read returns no guaranteed order).
			const summaries = yield* run((db) =>
				db
					.select(termSummaryColumns)
					.from(schema.termSummary)
					.where(sql`${schema.termSummary.slug} IN ${keys}`),
			);
			const bySlug = new Map(summaries.map((r) => [r.slug, toTermSummaryRow(r)]));
			const rows = keys.flatMap((slug) => {
				const row = bySlug.get(slug);
				return row ? [row] : [];
			});

			return {rows, hasNextPage, endCursor, totalCount} satisfies TermSearchPage;
		});

		const searchPosts = Effect.fn("Search.searchPosts")(function* (opts: SearchOpts) {
			const match = toMatchExpression(opts.query);
			if (match === null) return emptyPage<PostSummaryRow>();

			const first = clampFirst(opts.first);
			const after = opts.after ?? null;

			const {keys, hasNextPage, endCursor, totalCount} = yield* run((db) =>
				ftsKeysetKeys(db, "post_search", "id", {match, first, after}),
			);
			if (keys.length === 0) {
				return {rows: [], hasNextPage, endCursor, totalCount} satisfies PostSearchPage;
			}

			// Hydrate only live (non-deleted) posts, then re-order to FTS rank.
			const summaries = yield* run((db) =>
				db
					.select({
						id: schema.postSummary.id,
						slug: schema.postSummary.slug,
						title: schema.postSummary.title,
						url: schema.postSummary.url,
						host: schema.postSummary.host,
						bodyExcerpt: schema.postSummary.bodyExcerpt,
						authorId: schema.postSummary.authorId,
						authorName: schema.postSummary.authorName,
						score: schema.postSummary.score,
						commentCount: schema.postSummary.commentCount,
						createdAt: schema.postSummary.createdAt,
						tags: schema.postSummary.tags,
						removedAt: schema.postSummary.removedAt,
					})
					.from(schema.postSummary)
					.where(
						sql`${schema.postSummary.id} IN ${keys} AND ${schema.postSummary.removedAt} IS NULL`,
					),
			);
			const byId = new Map(
				summaries.map((r): [string, PostSummaryRow] => [
					r.id,
					{
						id: r.id,
						slug: r.slug,
						title: r.title,
						url: r.url,
						host: r.host,
						body: r.bodyExcerpt && r.bodyExcerpt.length > 0 ? r.bodyExcerpt : null,
						author: r.authorName,
						authorId: r.authorId,
						score: r.score,
						commentCount: r.commentCount,
						createdAt: r.createdAt ?? new Date(0),
						tags: parsePostTags(r.tags),
					},
				]),
			);
			const rows = keys.flatMap((id) => {
				const row = byId.get(id);
				return row ? [row] : [];
			});

			return {rows, hasNextPage, endCursor, totalCount} satisfies PostSearchPage;
		});

		return {searchTerms, searchPosts};
	}),
);

/**
 * Local copy of Pano's CSV tag parse — the shaper needs `{kind, label}` rows and
 * importing `Pano`'s private `parseTags` would couple the services. The tag enum
 * is fixed and the kind doubles as the label fallback (ADR 0080 reuses the
 * existing post-card components, which only read `kind`/`label`).
 */
const parsePostTags = (csv: string): Array<{kind: string; label: string}> => {
	if (!csv) return [];
	return csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((kind) => ({kind, label: kind}));
};
