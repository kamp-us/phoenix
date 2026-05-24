/**
 * Root list resolvers — custom `lists` entries.
 *
 * Per ADR 0019, **root lists** (`terms`, `posts`) resolve via custom
 * `lists` resolvers that map a service keyset page onto a `ConnectionResult`.
 * The service owns the cursor and the keyset SQL; this layer only reshapes the
 * page. Wrapped by `fateList` so the generator runs through the request runtime
 * (see `.patterns/fate-effect-bridge.md`, `.patterns/fate-connections.md`).
 *
 * `terms(sort, first, after)`:
 *   - `sort` is a plain validated string (`recent | popular`) — fate has no
 *     enum type (ADR 0018); an unknown value falls back to `recent`.
 *   - the cursor is the term slug (the keyset key, opaque to the client).
 */

import type {ConnectionResult} from "@nkzw/fate/server";
import {Pano, type PostSort} from "../features/pano/Pano";
import {type ListSort, Sozluk} from "../features/sozluk/Sozluk";
import {fateList} from "./effect";
import type {Post, Term} from "./views";

/** Coerce the `sort` arg to the service's `ListSort`; default `recent`. */
const toListSort = (value: unknown): ListSort => (value === "popular" ? "popular" : "recent");

/** Coerce the `sort` arg to the service's `PostSort`; default `hot`. */
const toPostSort = (value: unknown): PostSort =>
	value === "new" || value === "top" || value === "discuss" ? value : "hot";

/** Reshape a `Sozluk` term-summary page onto a `ConnectionResult<Term>`. */
const toTermConnection = (page: {
	rows: ReadonlyArray<{
		slug: string;
		title: string;
		count: number;
		totalScore: number;
		excerpt: string | null;
		firstAt: Date | null;
		lastEdit: Date | null;
		firstLetter: string;
		definitionCount: number;
		lastActivityAt: Date | null;
	}>;
	hasNextPage: boolean;
	endCursor: string | null;
}): ConnectionResult<Term> => ({
	items: page.rows.map((row) => ({
		cursor: row.slug,
		node: {
			__typename: "Term",
			id: row.slug,
			slug: row.slug,
			title: row.title,
			count: row.count,
			totalScore: row.totalScore,
			excerpt: row.excerpt,
			firstAt: row.firstAt,
			lastEdit: row.lastEdit,
			firstLetter: row.firstLetter,
			definitionCount: row.definitionCount,
			lastActivityAt: row.lastActivityAt,
		} satisfies Term,
	})),
	pagination: {
		// Services page forward only; the slug cursor is the service keyset.
		hasNext: page.hasNextPage,
		hasPrevious: false,
		...(page.endCursor ? {nextCursor: page.endCursor} : {}),
	},
});

export const lists = {
	terms: {
		type: "Term",
		resolve: fateList<{sort?: string; first?: number; after?: string}, Term>(function* ({args}) {
			const sozluk = yield* Sozluk;
			const page = yield* sozluk.listTermSummariesConnection({
				sort: toListSort(args?.sort),
				...(typeof args?.first === "number" ? {first: args.first} : {}),
				...(typeof args?.after === "string" ? {after: args.after} : {}),
			});
			return toTermConnection(page);
		}),
	},
	/**
	 * The sözlük **home** is two distinct term connections (recent + popular)
	 * rendered side by side. fate's `useRequest` keys map 1:1 to client root
	 * names (`RequestResult<R,Q>` → `K extends keyof R`), and the vite plugin
	 * forces the generated root name to equal the resolver name
	 * (`FateAPI['lists'][name]`), so one `terms` resolver cannot be aliased under
	 * two request keys. These two thin resolvers (each a fixed-sort wrapper over
	 * `listTermSummariesConnection`) give the home one batched
	 * `useRequest({recentTerms, popularTerms})` — no waterfall. The generic
	 * `terms(sort)` list stays for any caller that wants a single configurable
	 * connection.
	 */
	recentTerms: {
		type: "Term",
		resolve: fateList<{first?: number; after?: string}, Term>(function* ({args}) {
			const sozluk = yield* Sozluk;
			const page = yield* sozluk.listTermSummariesConnection({
				sort: "recent",
				...(typeof args?.first === "number" ? {first: args.first} : {}),
				...(typeof args?.after === "string" ? {after: args.after} : {}),
			});
			return toTermConnection(page);
		}),
	},
	popularTerms: {
		type: "Term",
		resolve: fateList<{first?: number; after?: string}, Term>(function* ({args}) {
			const sozluk = yield* Sozluk;
			const page = yield* sozluk.listTermSummariesConnection({
				sort: "popular",
				...(typeof args?.first === "number" ? {first: args.first} : {}),
				...(typeof args?.after === "string" ? {after: args.after} : {}),
			});
			return toTermConnection(page);
		}),
	},
	/**
	 * `posts(sort, host, first, after)`:
	 *   - `sort` is a plain validated string (`hot | new | top | discuss`,
	 *     default `hot`) — fate has no enum type (ADR 0018).
	 *   - `host` is an optional string filter.
	 *   - the cursor is the post id (the service keyset key).
	 *
	 * The service (`listPostsConnection`) pages by a DB keyset — resolving the
	 * cursor row once and applying the sort-specific keyset predicate — so this
	 * resolver only reshapes its page onto a `ConnectionResult`. `myVote` is left
	 * unstamped on the list rows; a viewer's votes surface on the post-detail
	 * `post` query.
	 */
	posts: {
		type: "Post",
		resolve: fateList<{sort?: string; host?: string; first?: number; after?: string}, Post>(
			function* ({args}) {
				const pano = yield* Pano;
				const page = yield* pano.listPostsConnection({
					sort: toPostSort(args?.sort),
					...(typeof args?.first === "number" ? {first: args.first} : {}),
					...(typeof args?.after === "string" ? {after: args.after} : {}),
					...(typeof args?.host === "string" && args.host.length > 0 ? {host: args.host} : {}),
				});
				const result: ConnectionResult<Post> = {
					items: page.rows.map((row) => ({
						cursor: row.id,
						node: {
							__typename: "Post",
							id: row.id,
							slug: row.slug,
							title: row.title,
							url: row.url,
							host: row.host,
							body: row.body,
							author: row.author,
							authorId: row.authorId,
							score: row.score,
							commentCount: row.commentCount,
							createdAt: row.createdAt,
							// Summary rows carry no updatedAt; fall back to
							// createdAt.
							updatedAt: row.updatedAt ?? row.createdAt,
							myVote: row.myVote ?? null,
							tags: row.tags,
						} satisfies Post,
					})),
					pagination: {
						hasNext: page.hasNextPage,
						hasPrevious: false,
						...(page.endCursor ? {nextCursor: page.endCursor} : {}),
					},
				};
				return result;
			},
		),
	},
};
