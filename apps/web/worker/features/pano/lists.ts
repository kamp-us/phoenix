/**
 * Pano root list resolvers — `posts(sort, host, first, after)`.
 *
 * Per ADR 0019, **root lists** resolve via custom `lists` resolvers that map a
 * service keyset page onto a `ConnectionResult`. The service owns the cursor
 * and the keyset SQL; this layer only reshapes the page. A `Fate.list` def +
 * `Effect.fn` pair (`.patterns/fate-effect-operations.md`,
 * `.patterns/fate-connections.md`).
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

import {Fate} from "@phoenix/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {toConnection} from "../fate/shapers.ts";
import {Pano, type PostSort} from "./Pano.ts";
import {toPost} from "./shapers.ts";
import type {Post} from "./views.ts";
import {PostView} from "./views.ts";

/** Coerce the `sort` arg to the service's `PostSort`; default `hot`. */
const toPostSort = (value: string | undefined): PostSort =>
	value === "new" || value === "top" || value === "discuss" ? value : "hot";

const PostsArgs = Schema.Struct({
	sort: Schema.optional(Schema.String),
	host: Schema.optional(Schema.String),
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
});

export const lists = {
	posts: Fate.list(
		{args: PostsArgs, type: PostView},
		Effect.fn("posts")(function* ({args}) {
			const pano = yield* Pano;
			const page = yield* pano.listPostsConnection({
				sort: toPostSort(args.sort),
				...(args.first !== undefined ? {first: args.first} : {}),
				...(args.after !== undefined ? {after: args.after} : {}),
				...(args.host !== undefined && args.host.length > 0 ? {host: args.host} : {}),
			});
			// Summary rows carry no `updatedAt`; `toPost` owns the
			// `updatedAt ?? createdAt` fallback.
			return toConnection<(typeof page.rows)[number], Post>(
				page,
				(row) => row.id,
				(row) => toPost(row),
			);
		}),
	),
};
