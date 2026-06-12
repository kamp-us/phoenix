/**
 * Pano root query resolvers — `post(idOrSlug)`.
 *
 * A `Fate.query` def + `Effect.fn("post")` pair
 * (`.patterns/fate-effect-operations.md`). Query resolvers return shaped
 * output directly — they are **not** masked through a source, so the resolver
 * builds the exact wire shape the client selected (including nested
 * connections).
 *
 * Roots:
 *   - `post(idOrSlug)` — the pano detail page. Returns the `Post` entity; when
 *     the selection includes `comments`, it carries a pre-built `ConnectionResult`
 *     paged by the DB keyset (`Pano.listCommentsKeyset`) in the canonical
 *     comment-thread order. See `.patterns/fate-connections.md`.
 */

import {hasNestedSelection} from "@nkzw/fate/server";
import {CurrentUser, Fate} from "@phoenix/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {connectionArgs, keysetInput, toConnection} from "../fate/connection.ts";
import {Pano} from "./Pano.ts";
import {toComment, toPostFromPage} from "./shapers.ts";
import type {Comment} from "./views.ts";
import {PostView} from "./views.ts";

/** Default page size for the nested `Post.comments` connection. */
const COMMENTS_PAGE_SIZE = 50;

/**
 * `post(idOrSlug)` args. Nested connection args are scoped under the field
 * path (`args.comments.{first,after}`), matching fate's `getScopedArgs`.
 * `Post.id` is the raw per-type post id (no global-id encoding — fate carries
 * the type on the operation).
 */
const PostArgs = Schema.Struct({
	idOrSlug: Schema.String,
	comments: connectionArgs(),
});

export const queries = {
	post: Fate.query(
		{args: PostArgs, type: PostView},
		Effect.fn("post")(function* ({args, select}) {
			const pano = yield* Pano;
			const page = yield* pano.getPost(args.idOrSlug);
			if (!page) return null;

			const {user} = yield* CurrentUser;
			const viewerId = user?.id ?? null;

			// Stamp the viewer's vote so `Post.myVote` is authoritative without a
			// per-row resolver: batch the single post through the same `user_vote`
			// read.
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId});

			const base = toPostFromPage(page, stamped?.myVote ?? null);

			// `comments` resolves to a `ConnectionResult` only when selected, paged
			// by the DB keyset (`Pano.listCommentsKeyset`). The native path
			// doesn't auto-invoke a nested relation's `connection` executor for a
			// hand-built source, so the resolver delivers it inline (see
			// fate-connections.md); the keyset, cursor, and node shape match the
			// source `connection` executor exactly.
			if (!hasNestedSelection(select, "comments")) {
				return base;
			}

			const connection = yield* pano.listCommentsKeyset(page.id, {
				...keysetInput(args.comments, COMMENTS_PAGE_SIZE),
				viewerId,
			});
			const comments = toConnection<(typeof connection.rows)[number], Comment>(
				connection,
				(row) => row.id,
				(row) => toComment(row),
			);

			return {...base, comments};
		}),
	),
};
