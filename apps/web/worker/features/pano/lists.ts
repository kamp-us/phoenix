/**
 * Pano root list resolvers. Per ADR 0019, root lists map a service keyset page
 * onto a `ConnectionResult`: the service owns the cursor and keyset SQL, this
 * layer only reshapes. `sort` is a plain validated string (no fate enum, ADR
 * 0018). See `.patterns/fate-connections.md`.
 *
 * - `posts` — the public feed. For a signed-in viewer the keyset page is
 *   re-hydrated through `Pano.getPostsByIds`, so `myVote`/`isSaved` ride the same
 *   batch as `savedPosts` and feed rows reflect the viewer's real vote/save state;
 *   signed-out skips the extra read and resolves to neutral state.
 * - `savedPosts` — the viewer's bookmarks, ordered by save time, `CurrentUser`-
 *   scoped; signed-out resolves to an empty connection (the read-path "viewer
 *   scalar degrades, never throws" convention). Hydrated through
 *   `Pano.getPostsByIds`, so `isSaved`/`myVote` ride the same batch as the feed.
 */

import {CurrentUser, Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {toPostSort} from "../../../src/lib/panoFeedSort.ts";
import {emptyKeysetPage} from "../../db/keyset.ts";
import {toConnection} from "../fate/connection.ts";
import {currentSandboxViewer} from "../kunye/sandbox.ts";
import {Bookmark} from "./Bookmark.ts";
import {Pano, type PostSummaryRow} from "./Pano.ts";
import {toPost} from "./shapers.ts";
import type {Post} from "./views.ts";
import {PostView} from "./views.ts";

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
			// Resolve the sandbox viewer once (identity + moderator probe); the feed
			// hides çaylak-sandboxed posts from anyone but their author + a mod (#1205).
			const sandboxViewer = yield* currentSandboxViewer;
			const viewerId = sandboxViewer.viewerId;
			const pano = yield* Pano;
			const page = yield* pano.listPostsConnection({
				sort: toPostSort(args.sort),
				...(args.first !== undefined ? {first: args.first} : {}),
				...(args.after !== undefined ? {after: args.after} : {}),
				...(args.host !== undefined && args.host.length > 0 ? {host: args.host} : {}),
				sandboxViewer,
			});

			// Signed-out: serve the keyset page as-is (neutral `myVote`/`isSaved`).
			if (!viewerId) {
				return toConnection<PostSummaryRow, Post>(
					page,
					(row) => row.id,
					(row) => toPost(row),
				);
			}

			// Signed-in: re-hydrate the page ids through `getPostsByIds` to batch-stamp
			// the viewer's `myVote`/`isSaved`, then re-order to the keyset (the `inArray`
			// fetch loses the sort), mirroring `savedPosts`.
			const ids = page.rows.map((row) => row.id);
			const hydrated = yield* pano.getPostsByIds(ids, {viewerId, sandboxViewer});
			const byId = new Map(hydrated.map((row) => [row.id, row]));
			const rows = page.rows.flatMap((row) => {
				const stamped = byId.get(row.id);
				return stamped ? [stamped] : [];
			});

			return toConnection<PostSummaryRow, Post>(
				{rows, hasNextPage: page.hasNextPage, endCursor: page.endCursor},
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
