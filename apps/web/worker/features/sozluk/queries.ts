/**
 * Sözlük root query resolvers — `term(slug)`.
 *
 * Thin orchestration over `Sozluk`, wrapped by `fateQuery` so it runs through
 * the request runtime (see `.patterns/fate-effect-bridge.md`). Query resolvers
 * return shaped output directly — they are **not** masked through a source, so
 * the resolver builds the exact wire shape the client selected (including
 * nested connections).
 *
 * Roots:
 *   - `term(slug)` — the sozluk detail page. Returns the `Term` entity; when the
 *     selection includes `definitions`, it carries a pre-built `ConnectionResult`
 *     paged by the DB keyset (`Sozluk.listDefinitionsKeyset`) in the canonical
 *     term-page order. See the connection note in `.patterns/fate-connections.md`.
 */

import type {ConnectionResult} from "@nkzw/fate/server";
import {hasNestedSelection} from "@nkzw/fate/server";
import {fateQuery} from "../fate/effect.ts";
import {toConnection} from "../fate/shapers.ts";
import type {Definition, Term} from "../fate/views.ts";
import {Auth} from "../pasaport/Auth.ts";
import {Sozluk} from "./Sozluk.ts";
import {toDefinition, toTermFromPage} from "./shapers.ts";

/** Default page size for the nested `Term.definitions` connection. */
const DEFINITIONS_PAGE_SIZE = 50;

export const queries = {
	term: {
		type: "Term",
		resolve: fateQuery<{slug: string; definitions?: {first?: number; after?: string}}, Term | null>(
			function* ({args, select}) {
				const slug = args?.slug ?? "";
				const sozluk = yield* Sozluk;
				const page = yield* sozluk.getTerm(slug);
				if (!page) return null;

				const auth = yield* Auth;
				const viewerId = auth.user?.id ?? null;

				// Build the `Term` row to the view's scalar shape: the detail `TermPage`
				// maps onto the `TermSummaryRow`-shaped view here.
				const base = toTermFromPage(page);

				// `definitions` resolves to a `ConnectionResult` only when selected,
				// paged by the DB keyset. The native path doesn't auto-invoke a
				// nested relation's `connection` executor for a hand-built source, so
				// the resolver delivers the connection inline (see
				// fate-connections.md); the keyset, cursor, and node shape match the
				// source `connection` executor exactly.
				if (!hasNestedSelection(select, "definitions")) {
					return base;
				}

				// Nested connection args are scoped under the field path
				// (`args.definitions.{first,after}`), matching fate's `getScopedArgs`.
				const defArgs = args?.definitions;
				const connection = yield* sozluk.listDefinitionsKeyset(slug, {
					first: typeof defArgs?.first === "number" ? defArgs.first : DEFINITIONS_PAGE_SIZE,
					...(typeof defArgs?.after === "string" ? {after: defArgs.after} : {}),
					viewerId,
				});
				const definitions = toConnection<(typeof connection.rows)[number], Definition>(
					connection,
					(row) => row.id,
					(row) => toDefinition(row),
				);

				return {...base, definitions} as Term & {definitions: ConnectionResult<Definition>};
			},
		),
	},
};
