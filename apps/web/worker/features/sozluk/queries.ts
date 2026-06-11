/**
 * Sözlük root query resolvers — `term(slug)`.
 *
 * A `Fate.query` def + `Effect.fn("term")` pair
 * (`.patterns/fate-effect-operations.md`). Query resolvers return shaped
 * output directly — they are **not** masked through a source, so the resolver
 * builds the exact wire shape the client selected (including nested
 * connections).
 *
 * Roots:
 *   - `term(slug)` — the sozluk detail page. Returns the `Term` entity; when the
 *     selection includes `definitions`, it carries a pre-built `ConnectionResult`
 *     paged by the DB keyset (`Sozluk.listDefinitionsKeyset`) in the canonical
 *     term-page order. See the connection note in `.patterns/fate-connections.md`.
 */

import {hasNestedSelection} from "@nkzw/fate/server";
import {CurrentUser, Fate} from "@phoenix/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {toConnection} from "../fate/shapers.ts";
import {Sozluk} from "./Sozluk.ts";
import {toDefinition, toTermFromPage} from "./shapers.ts";
import type {Definition} from "./views.ts";
import {TermView} from "./views.ts";

/** Default page size for the nested `Term.definitions` connection. */
const DEFINITIONS_PAGE_SIZE = 50;

/**
 * `term(slug)` args. Nested connection args are scoped under the field path
 * (`args.definitions.{first,after}`), matching fate's `getScopedArgs`.
 */
const TermArgs = Schema.Struct({
	slug: Schema.String,
	definitions: Schema.optional(
		Schema.Struct({
			first: Schema.optional(Schema.Number),
			after: Schema.optional(Schema.String),
		}),
	),
});

export const queries = {
	term: Fate.query(
		{args: TermArgs, type: TermView},
		Effect.fn("term")(function* ({args, select}) {
			const sozluk = yield* Sozluk;
			const page = yield* sozluk.getTerm(args.slug);
			if (!page) return null;

			const {user} = yield* CurrentUser;
			const viewerId = user?.id ?? null;

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

			const defArgs = args.definitions;
			const connection = yield* sozluk.listDefinitionsKeyset(args.slug, {
				first: defArgs?.first ?? DEFINITIONS_PAGE_SIZE,
				...(defArgs?.after !== undefined ? {after: defArgs.after} : {}),
				viewerId,
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
