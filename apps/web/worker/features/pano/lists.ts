/**
 * Pano root list resolvers. Per ADR 0019, root lists map a service keyset page
 * onto a `ConnectionResult`: the service owns the cursor and keyset SQL, this
 * layer only reshapes. `sort` is a plain validated string (no fate enum, ADR
 * 0018). See `.patterns/fate-connections.md`.
 *
 * - `posts` — the public feed; `myVote`/`isSaved` are left unstamped on list
 *   rows (they surface on the post-detail `post` query).
 * - `savedPosts` — the viewer's bookmarks, ordered by save time, `CurrentUser`-
 *   scoped; signed-out resolves to an empty connection (the read-path "viewer
 *   scalar degrades, never throws" convention). Hydrated through
 *   `Pano.getPostsByIds`, so `isSaved`/`myVote` ride the same batch as the feed.
 */

import {CurrentUser, Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {emptyKeysetPage} from "../../db/keyset.ts";
import {toConnection} from "../fate/connection.ts";
import {Bookmark} from "./Bookmark.ts";
import {Pano, type PostSort, type PostSummaryRow} from "./Pano.ts";
import {toPost} from "./shapers.ts";
import type {Post} from "./views.ts";
import {PostView} from "./views.ts";

const toPostSort = (value: string | undefined): PostSort =>
	value === "new" || value === "top" || value === "discuss" ? value : "hot";

const PostsArgs = Schema.Struct({
	sort: Schema.optional(Schema.String),
	host: Schema.optional(Schema.String),
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
});

const SavedPostsArgs = Schema.Struct({
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
			return toConnection<(typeof page.rows)[number], Post>(
				page,
				(row) => row.id,
				(row) => toPost(row),
			);
		}),
	),

	savedPosts: Fate.list(
		{args: SavedPostsArgs, type: PostView},
		Effect.fn("savedPosts")(function* ({args}) {
			const {user} = yield* CurrentUser;
			const viewerId = user?.id ?? null;
			if (!viewerId) {
				return toConnection<PostSummaryRow, Post>(
					emptyKeysetPage,
					(row) => row.id,
					(row) => toPost(row),
				);
			}

			const bookmark = yield* Bookmark;
			const pano = yield* Pano;
			const page = yield* bookmark.listSavedConnection(viewerId, {
				...(args.first !== undefined ? {first: args.first} : {}),
				...(args.after !== undefined ? {after: args.after} : {}),
			});

			// `getPostsByIds` stamps `isSaved`/`myVote` in one batch but loses the
			// save-time order (`inArray`), so re-order to the bookmark keyset.
			const hydrated = yield* pano.getPostsByIds(page.ids, {viewerId});
			const byId = new Map(hydrated.map((row) => [row.id, row]));
			const rows = page.ids.flatMap((id) => {
				const row = byId.get(id);
				return row ? [row] : [];
			});

			return toConnection<PostSummaryRow, Post>(
				{rows, hasNextPage: page.hasNextPage, endCursor: page.endCursor},
				(row) => row.id,
				(row) => toPost(row),
			);
		}),
	),
};
