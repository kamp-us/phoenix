/**
 * Search root list resolvers (ADR 0080). Per-type roots with no unified `SearchResult`,
 * each reusing the existing `Term` / `Post` view + shaper so results render with the
 * verbatim components. See `.patterns/fate-connections.md`.
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
			// Search masks posts through the pano visibility seam (ADR 0113), so it must
			// resolve the viewer rather than reading sandbox-blind.
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
