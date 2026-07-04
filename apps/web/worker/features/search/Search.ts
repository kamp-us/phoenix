/**
 * Search — the lexical site-search service (ADR 0080). Owns the FTS5 read path:
 * a bm25-ranked, keyset-paginated MATCH over the `term_search` / `post_search`
 * virtual tables, joined back to `term_record` / `post_record` for the row
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

import {and, isNull, type SQL, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {forwardPage, resolveCursor} from "../../db/keyset.ts";
import {anonymousViewer, type SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import type {PostSummaryRow} from "../pano/Pano.ts";
import {postVisibleWhere} from "../pano/PostVisibility.ts";
import {toPostSummaryKeysetRow} from "../pano/post-fields.ts";
import {type TermSummaryRow, termSummaryColumns, toTermSummaryRow} from "../sozluk/term-fields.ts";
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

/**
 * `searchPosts` carries a {@link SandboxViewer} so the FTS read masks posts through
 * the pano visibility seam (ADR 0113) the same way every other pano read does —
 * sandboxed and draft posts excluded per viewer. Omitted reads as the least-privileged
 * {@link anonymousViewer} (public-only), the fail-safe default. Terms have no sandbox
 * or draft dimension, so `searchTerms` needs no viewer.
 */
export interface SearchPostsOpts extends SearchOpts {
	viewer?: SandboxViewer | undefined;
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

		/**
		 * bm25-ranked keyset page of post-title matches (full `PostSummaryRow`s),
		 * masked to the viewer's visible set via the pano seam — see {@link SearchPostsOpts}.
		 */
		readonly searchPosts: (opts: SearchPostsOpts) => Effect.Effect<PostSearchPage>;
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
	visibleFilter: SQL | undefined,
): Promise<number | null> => {
	const visible = visibleFilter ? sql` AND ${visibleFilter}` : sql``;
	const row = await db
		.run(
			sql`SELECT bm25(${sql.raw(ftsTable)}) AS rank FROM ${sql.raw(ftsTable)} WHERE ${sql.raw(ftsTable)} MATCH ${match} AND ${sql.raw(keyColumn)} = ${key}${visible}`,
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
	opts: {match: string; first: number; after: string | null; visibleFilter?: SQL | undefined},
): Promise<{
	keys: string[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}> => {
	const {match, first, after, visibleFilter} = opts;
	// The viewer's visibility predicate rides EVERY query over the FTS table — count,
	// cursor-rank, and the keyed fetch — not just the hydrate. Masking the hydrate
	// alone would leave `totalCount` and the keyset counting/slotting rows the viewer
	// can't see (the #1312 count/pagination leak); applied here, count, cursor, keys,
	// and rows all reflect the same visible set (#1358).
	const visible = visibleFilter ? sql` AND ${visibleFilter}` : sql``;

	const totalCount = await db
		.run(
			sql`SELECT count(*) AS n FROM ${sql.raw(ftsTable)} WHERE ${sql.raw(ftsTable)} MATCH ${match}${visible}`,
		)
		.then((r) => Number((r.results[0] as {n: number} | undefined)?.n ?? 0));

	// The DB read (resolveCursorRank) is the port; `resolveCursor` is the pure
	// cursor-miss decision (ADR 0082). bm25 rank `0` is a valid hit, not a miss.
	const cursor = resolveCursor<number>(
		after,
		after ? await resolveCursorRank(db, ftsTable, keyColumn, match, after, visibleFilter) : null,
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
			sql`SELECT ${sql.raw(keyColumn)} AS key FROM ${sql.raw(ftsTable)} WHERE ${sql.raw(ftsTable)} MATCH ${match}${visible}${after_} ORDER BY ${rankExpr} ASC, ${sql.raw(keyColumn)} ASC LIMIT ${first + 1}`,
		)
		.then((r) => (r.results as Array<{key: string}>).map((row) => row.key));

	const page = forwardPage(fetched, first, (key: string) => key);
	return {keys: page.rows, hasNextPage: page.hasNextPage, endCursor: page.endCursor, totalCount};
};

/**
 * The viewer's post read-mask as an FTS-query predicate: the post id must be in the
 * set of non-removed, visible posts for this viewer. `post_search` holds only
 * `id`/`norm` (no lifecycle columns), so the mask is expressed as `id IN (<visible
 * post ids>)` joining back to `post_record`. The visibility predicate is sourced from
 * the one pano seam — {@link postVisibleWhere} (ADR 0113): the shared sandbox arm AND
 * the author-only draft arm, so a çaylak's sandboxed post and another author's draft
 * are both excluded unless the viewer is its author (sandbox: or a moderator). The
 * caller keeps the orthogonal `removed_at IS NULL` removal guard (ADR 0096) beside it.
 */
const postVisibleFilter = (db: DrizzleDb, viewer: SandboxViewer): SQL => {
	const visibleIds = db
		.select({id: schema.postRecord.id})
		.from(schema.postRecord)
		.where(
			and(
				isNull(schema.postRecord.removedAt),
				postVisibleWhere(
					{
						sandboxedAt: schema.postRecord.sandboxedAt,
						authorId: schema.postRecord.authorId,
						isDraft: schema.postRecord.isDraft,
					},
					viewer,
				),
			),
		);
	return sql`id IN (${visibleIds})`;
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
					.from(schema.termRecord)
					.where(sql`${schema.termRecord.slug} IN ${keys}`),
			);
			const bySlug = new Map(summaries.map((r) => [r.slug, toTermSummaryRow(r)]));
			const rows = keys.flatMap((slug) => {
				const row = bySlug.get(slug);
				return row ? [row] : [];
			});

			return {rows, hasNextPage, endCursor, totalCount} satisfies TermSearchPage;
		});

		const searchPosts = Effect.fn("Search.searchPosts")(function* (opts: SearchPostsOpts) {
			const match = toMatchExpression(opts.query);
			if (match === null) return emptyPage<PostSummaryRow>();

			const first = clampFirst(opts.first);
			const after = opts.after ?? null;
			const viewer = opts.viewer ?? anonymousViewer;

			const {keys, hasNextPage, endCursor, totalCount} = yield* run((db) =>
				ftsKeysetKeys(db, "post_search", "id", {
					match,
					first,
					after,
					visibleFilter: postVisibleFilter(db, viewer),
				}),
			);
			if (keys.length === 0) {
				return {rows: [], hasNextPage, endCursor, totalCount} satisfies PostSearchPage;
			}

			// Hydrate only live (non-deleted) posts through the SHARED pano mapper
			// (`toPostSummaryKeysetRow`) so post_record→PostSummaryRow — including the
			// `tags` CSV parse via `tagLabel` — is the single mapping the feed and
			// keyset already cross (#2015). The local shaping drifted: it rendered the
			// raw tag value (`show`) where the shared mapper resolves the legacy alias
			// to the canonical Turkish label (`göster`). The select is the exact
			// `PostKeysetRow` column subset the mapper reads. `removed_at` is the WHERE
			// guard only (ADR 0096), spelled against the table — not a hydrated field.
			const summaries = yield* run((db) =>
				db
					.select({
						id: schema.postRecord.id,
						slug: schema.postRecord.slug,
						title: schema.postRecord.title,
						url: schema.postRecord.url,
						host: schema.postRecord.host,
						bodyExcerpt: schema.postRecord.bodyExcerpt,
						authorId: schema.postRecord.authorId,
						authorName: schema.postRecord.authorName,
						score: schema.postRecord.score,
						commentCount: schema.postRecord.commentCount,
						createdAt: schema.postRecord.createdAt,
						tags: schema.postRecord.tags,
					})
					.from(schema.postRecord)
					.where(
						sql`${schema.postRecord.id} IN ${keys} AND ${schema.postRecord.removedAt} IS NULL`,
					),
			);
			const byId = new Map(
				summaries.map((r): [string, PostSummaryRow] => [r.id, toPostSummaryKeysetRow(r)]),
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
