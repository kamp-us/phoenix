/**
 * Pano root list resolvers — `posts(sort, host, first, after)`.
 *
 * Per ADR 0019, **root lists** resolve via custom `lists` resolvers that map a
 * service keyset page onto a `ConnectionResult`. The service owns the cursor
 * and the keyset SQL; this layer only reshapes the page. Wrapped by `fateList`
 * so the generator runs through the request runtime
 * (see `.patterns/fate-effect-bridge.md`, `.patterns/fate-connections.md`).
 *
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

import {fateList} from "../fate/effect.ts";
import {toConnection} from "../fate/shapers.ts";
import type {Post} from "../fate/views.ts";
import {Pano, type PostSort} from "./Pano.ts";
import {toPost} from "./shapers.ts";

/** Coerce the `sort` arg to the service's `PostSort`; default `hot`. */
const toPostSort = (value: unknown): PostSort =>
	value === "new" || value === "top" || value === "discuss" ? value : "hot";

export const lists = {
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
				// Summary rows carry no `updatedAt`; `toPost` owns the
				// `updatedAt ?? createdAt` fallback.
				return toConnection<(typeof page.rows)[number], Post>(
					page,
					(row) => row.id,
					(row) => toPost(row),
				);
			},
		),
	},
};
