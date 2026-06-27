/**
 * Sözlük root query resolvers — `term(slug)`, the detail page.
 *
 * Query resolvers return shaped output directly (not masked through a source),
 * so the resolver builds the exact wire shape the client selected, including the
 * nested `definitions` connection paged by the DB keyset (ADR 0019; see
 * `.patterns/fate-effect-operations.md`, `.patterns/fate-connections.md`).
 */

import {Fate} from "@kampus/fate-effect";
import {hasNestedSelection} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {connectionArgs, keysetInput, toConnection} from "../fate/connection.ts";
import {currentSandboxViewer} from "../kunye/sandbox.ts";
import {Sozluk} from "./Sozluk.ts";
import {toDefinition, toTermFromPage} from "./shapers.ts";
import type {Definition} from "./views.ts";
import {TermView} from "./views.ts";

const DEFINITIONS_PAGE_SIZE = 50;

// Nested connection args are scoped under the field path
// (`args.definitions.{first,after}`), matching fate's `getScopedArgs`.
const TermArgs = Schema.Struct({
	slug: Schema.String,
	definitions: connectionArgs(),
});

export const queries = {
	term: Fate.query(
		{args: TermArgs, type: TermView},
		Effect.fn("term")(function* ({args, select}) {
			const sozluk = yield* Sozluk;
			// Resolve the sandbox viewer once (identity + moderator probe) so the
			// term + its definitions filter çaylak-sandboxed content per #1205.
			const sandboxViewer = yield* currentSandboxViewer;
			const viewerId = sandboxViewer.viewerId;
			const page = yield* sozluk.getTerm(args.slug, {sandboxViewer});
			if (!page) return null;

			const base = toTermFromPage(page);

			// The native path won't auto-invoke a nested relation's `connection`
			// executor for a hand-built source, so the resolver delivers the
			// connection inline when selected (see `.patterns/fate-connections.md`).
			if (!hasNestedSelection(select, "definitions")) {
				return base;
			}

			const connection = yield* sozluk.listDefinitionsKeyset(args.slug, {
				...keysetInput(args.definitions, DEFINITIONS_PAGE_SIZE),
				viewerId,
				sandboxViewer,
			});
			const definitions = toConnection<(typeof connection.rows)[number], Definition>(
				connection,
				(row) => row.id,
				(row) => toDefinition(row),
			);

			return {...base, definitions};
		}),
	),
};
