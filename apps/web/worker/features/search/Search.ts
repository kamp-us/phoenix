/**
 * Search — the lexical site-search service (ADR 0080). A bm25-ranked,
 * keyset-paginated MATCH over the `term_search` / `post_search` virtual tables,
 * joined back to `term_record` / `post_record`. The write-side FTS sync lives in
 * `fts-sync.ts` (dual-write from the mutation handlers, not triggers).
 *
 * Keyset is `(bm25 rank asc, key asc)`: bm25 returns more-negative for a better
 * match, so ASCENDING rank is relevance-first.
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
 * Omitting `viewer` reads as the least-privileged {@link anonymousViewer}
 * (public-only) — the fail-safe default. Terms have no sandbox or draft dimension,
 * so `searchTerms` needs no viewer.
 */
export interface SearchPostsOpts extends SearchOpts {
	viewer?: SandboxViewer | undefined;
}

export class Search extends Context.Service<
	Search,
	{
		readonly searchTerms: (opts: SearchOpts) => Effect.Effect<TermSearchPage>;

		readonly searchPosts: (opts: SearchPostsOpts) => Effect.Effect<PostSearchPage>;
	}
>()("@kampus/search/Search") {}

/**
 * The cursor row's bm25 rank for the same MATCH (bm25 is stable for a given doc +
 * query). A key that no longer matches is a cursor miss → `null`.
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
 * The shared FTS read: count, resolve the cursor, fetch the keyed page ordered
 * `(bm25 asc, key asc)`. Returns keys only; the caller hydrates rows.
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
	// The viewer's visibility predicate must ride EVERY query over the FTS table — count,
	// cursor-rank and the keyed fetch — not just the hydrate. Masking the hydrate alone
	// left `totalCount` and the keyset counting rows the viewer cannot see (#1312/#1358).
	const visible = visibleFilter ? sql` AND ${visibleFilter}` : sql``;

	const totalCount = await db
		.run(
			sql`SELECT count(*) AS n FROM ${sql.raw(ftsTable)} WHERE ${sql.raw(ftsTable)} MATCH ${match}${visible}`,
		)
		.then((r) => Number((r.results[0] as {n: number} | undefined)?.n ?? 0));

	// `resolveCursor` is the pure cursor-miss decision (ADR 0082). A bm25 rank of `0` is
	// a valid hit, not a miss.
	const cursor = resolveCursor<number>(
		after,
		after ? await resolveCursorRank(db, ftsTable, keyColumn, match, after, visibleFilter) : null,
	);
	if (cursor.kind === "miss") {
		return {keys: [], hasNextPage: false, endCursor: null, totalCount};
	}
	const cursorRank = cursor.kind === "hit" ? cursor.row : null;

	// bm25() cannot be referenced by its SELECT alias in WHERE, so it is re-spelled inline.
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
 * The viewer's post read-mask as an FTS-query predicate. `post_search` holds only
 * `id`/`norm` (no lifecycle columns), so the mask joins back to `post_record` as
 * `id IN (<visible post ids>)`, sourced from the one pano seam {@link postVisibleWhere}
 * (ADR 0113). The orthogonal `removed_at IS NULL` removal guard stays with the caller.
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

			// Re-order to the FTS rank order: a keyed `IN (...)` read returns no guaranteed order.
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

			// Hydrate through the SHARED pano mapper (`toPostSummaryKeysetRow`) — the local
			// shaping had drifted, rendering the raw tag value where the shared mapper resolves
			// the legacy alias to the canonical Turkish label (#2015). The select is exactly the
			// `PostKeysetRow` column subset it reads; `removed_at` is a WHERE guard only.
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
