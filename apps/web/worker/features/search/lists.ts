/**
 * Search root list resolvers — `searchTerms` / `searchPosts` (ADR 0080). Per-type
 * roots (no unified `SearchResult`), each reusing the existing `Term` / `Post`
 * view + shaper so #122 renders results with the verbatim `TermRow` / post-card
 * components. The service owns the FTS5 MATCH + bm25 keyset SQL (ADR 0019); this
 * layer validates the `query` arg and reshapes the page onto a `ConnectionResult`.
 * See `.patterns/fate-connections.md`.
 */

import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {toConnection} from "../fate/connection.ts";
import {currentSandboxViewer} from "../kunye/sandbox.ts";
import {toPost} from "../pano/shapers.ts";
import type {Post} from "../pano/views.ts";
import {PostView} from "../pano/views.ts";
import {toTerm} from "../sozluk/shapers.ts";
import {TermView} from "../sozluk/views.ts";
import {Search} from "./Search.ts";

const SearchArgs = Schema.Struct({
	query: Schema.String,
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
});

export const lists = {
	searchTerms: Fate.list(
		{args: SearchArgs, type: TermView},
		Effect.fn("searchTerms")(function* ({args}) {
			const search = yield* Search;
			const page = yield* search.searchTerms({
				query: args.query,
				...(args.first !== undefined ? {first: args.first} : {}),
				...(args.after !== undefined ? {after: args.after} : {}),
			});
			return toConnection(page, (row) => row.slug, toTerm);
		}),
	),
	searchPosts: Fate.list(
		{args: SearchArgs, type: PostView},
		Effect.fn("searchPosts")(function* ({args}) {
			// Resolve the sandbox viewer once (identity + moderator probe); search hides
			// çaylak-sandboxed posts from anyone but their author + a mod (#1358), the
			// same mask `posts`/`getPost` apply (#1205).
			const sandboxViewer = yield* currentSandboxViewer;
			const search = yield* Search;
			const page = yield* search.searchPosts({
				query: args.query,
				...(args.first !== undefined ? {first: args.first} : {}),
				...(args.after !== undefined ? {after: args.after} : {}),
				viewer: sandboxViewer,
			});
			return toConnection<(typeof page.rows)[number], Post>(
				page,
				(row) => row.id,
				(row) => toPost(row),
			);
		}),
	),
};
