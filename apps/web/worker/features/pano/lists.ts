/**
 * Pano root list resolver — `posts(sort, host, first, after)`. Per ADR 0019,
 * root lists map a service keyset page onto a `ConnectionResult`: the service
 * (`listPostsConnection`) owns the cursor and keyset SQL, this layer only
 * reshapes. `sort` is a plain validated string (no fate enum, ADR 0018).
 * `myVote` is left unstamped on list rows; a viewer's votes surface on the
 * post-detail `post` query. See `.patterns/fate-connections.md`.
 */

import {Fate} from "@phoenix/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {toConnection} from "../fate/connection.ts";
import {Pano, type PostSort} from "./Pano.ts";
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
};
