/**
 * Pano root query resolver — `post(idOrSlug)`, the detail page. Query resolvers
 * return shaped output directly (NOT masked through a source), so this builds
 * the exact wire shape the client selected, including the nested `comments`
 * connection. See `.patterns/fate-effect-operations.md`,
 * `.patterns/fate-connections.md`.
 */

import {Fate} from "@kampus/fate-effect";
import {hasNestedSelection} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {PHOENIX_PANO_STAMP_WAVE} from "../../../src/flags/keys.ts";
import {connectionArgs, keysetInput, toConnection} from "../fate/connection.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {currentSandboxViewer} from "../kunye/sandbox.ts";
import {currentMutedIds} from "../mute/read-mask.ts";
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
			// Resolve the sandbox viewer once (identity + moderator probe); a
			// sandboxed post is hidden from anyone but its author + a moderator (#1205).
			const sandboxViewer = yield* currentSandboxViewer;
			const viewerId = sandboxViewer.viewerId;
			// Mute read-mask (#3113): a muted author's post + its thread read as
			// not-found for the muter (default-off `member-mute` ⇒ empty set ⇒ unchanged).
			const mutedIds = yield* currentMutedIds;
			const page = yield* pano.getPost(args.idOrSlug, {sandboxViewer, mutedIds});
			if (!page) return null;

			// Stamp `myVote` + `isSaved` by batching the single post through the same
			// `user_vote` / `post_bookmark` read — no per-row resolver.
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId, sandboxViewer, mutedIds});

			const base = toPostFromPage(
				page,
				stamped?.myVote ?? null,
				stamped?.isSaved ?? null,
				stamped?.reactions,
				{
					authorUsername: stamped?.authorUsername ?? null,
					authorDisplayName: stamped?.authorDisplayName ?? null,
				},
				stamped?.sandboxed ?? false,
			);

			// The native path doesn't auto-invoke a nested relation's `connection`
			// executor for a hand-built source, so deliver `comments` inline; the
			// keyset, cursor, and node shape match the source executor exactly (see
			// fate-connections.md).
			if (!hasNestedSelection(select, "comments")) {
				return base;
			}

			// The thread read's stamp collapse is contained behind its default-off flag
			// (#2710): off ⇒ the stamps run serially (today), on ⇒ one concurrent wave.
			const flags = yield* Flags;
			const parallelStamps = yield* flags
				.getBoolean(PHOENIX_PANO_STAMP_WAVE, false)
				.pipe(provideRequestFlags);
			const connection = yield* pano.listCommentsKeyset(page.id, {
				...keysetInput(args.comments, COMMENTS_PAGE_SIZE),
				viewerId,
				sandboxViewer,
				mutedIds,
				parallelStamps,
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
