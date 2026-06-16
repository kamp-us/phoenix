/**
 * Pano root query resolver — `post(idOrSlug)`, the detail page. Query resolvers
 * return shaped output directly (NOT masked through a source), so this builds
 * the exact wire shape the client selected, including the nested `comments`
 * connection. See `.patterns/fate-effect-operations.md`,
 * `.patterns/fate-connections.md`.
 */

import {CurrentUser, Fate} from "@kampus/fate-effect";
import {hasNestedSelection} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {connectionArgs, keysetInput, toConnection} from "../fate/connection.ts";
import {Pano} from "./Pano.ts";
import {toComment, toPostFromPage} from "./shapers.ts";
import type {Comment} from "./views.ts";
import {PostView} from "./views.ts";

const COMMENTS_PAGE_SIZE = 50;

// Nested connection args are scoped under the field path
// (`args.comments.{first,after}`), matching fate's `getScopedArgs`.
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

			// Stamp `myVote` by batching the single post through the same `user_vote`
			// read — no per-row resolver.
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId});

			const base = toPostFromPage(page, stamped?.myVote ?? null);

			// The native path doesn't auto-invoke a nested relation's `connection`
			// executor for a hand-built source, so deliver `comments` inline; the
			// keyset, cursor, and node shape match the source executor exactly (see
			// fate-connections.md).
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
