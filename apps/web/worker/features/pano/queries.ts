/**
 * Pano root query resolvers — `post(idOrSlug)`.
 *
 * Thin orchestration over `Pano`, wrapped by `fateQuery` so it runs through the
 * request runtime (see `.patterns/fate-effect-bridge.md`). Query resolvers
 * return shaped output directly — they are **not** masked through a source, so
 * the resolver builds the exact wire shape the client selected (including
 * nested connections).
 *
 * Roots:
 *   - `post(idOrSlug)` — the pano detail page. Returns the `Post` entity; when
 *     the selection includes `comments`, it carries a pre-built `ConnectionResult`
 *     paged by the DB keyset (`Pano.listCommentsKeyset`) in the canonical
 *     comment-thread order. See `.patterns/fate-connections.md`.
 */

import type {ConnectionResult} from "@nkzw/fate/server";
import {hasNestedSelection} from "@nkzw/fate/server";
import {fateQuery} from "../fate/effect.ts";
import {toConnection} from "../fate/shapers.ts";
import type {Comment, Post} from "../fate/views.ts";
import {Auth} from "../pasaport/Auth.ts";
import {Pano} from "./Pano.ts";
import {toComment, toPostFromPage} from "./shapers.ts";

/** Default page size for the nested `Post.comments` connection. */
const COMMENTS_PAGE_SIZE = 50;

export const queries = {
	post: {
		type: "Post",
		resolve: fateQuery<
			{idOrSlug: string; comments?: {first?: number; after?: string}},
			Post | null
		>(function* ({args, select}) {
			// Raw per-type id (no global-id encoding — fate carries the type on the
			// operation). `Post.id` is the raw post id.
			const key = args?.idOrSlug ?? "";
			const pano = yield* Pano;
			const page = yield* pano.getPost(key);
			if (!page) return null;

			const auth = yield* Auth;
			const viewerId = auth.user?.id ?? null;

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

			const cArgs = args?.comments;
			const connection = yield* pano.listCommentsKeyset(page.id, {
				first: typeof cArgs?.first === "number" ? cArgs.first : COMMENTS_PAGE_SIZE,
				...(typeof cArgs?.after === "string" ? {after: cArgs.after} : {}),
				viewerId,
			});
			const comments = toConnection<(typeof connection.rows)[number], Comment>(
				connection,
				(row) => row.id,
				(row) => toComment(row),
			);

			return {...base, comments} as Post & {comments: ConnectionResult<Comment>};
		}),
	},
};
