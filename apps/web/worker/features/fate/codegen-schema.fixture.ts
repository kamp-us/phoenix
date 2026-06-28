/**
 * Codegen fixture — the `schema.ts` shape of the fate-effect era, fed to the
 * REAL fate Vite plugin in `codegen-vite.test.ts`. Mirrors `schema.ts`'s shape
 * but is self-contained (no live feature imports), so it pins the module SHAPE
 * against the plugin, not the live config's content. Handlers close over a
 * throw-on-touch Proxy standing in for D1: if the codegen path executed
 * anything, generation would fail loudly — the "no D1 at build time" proof.
 */

import {type Entity, Fate, FateDataView, FateExecutor, FateServer} from "@kampus/fate-effect";
import type {ConnectionResult} from "@nkzw/fate/server";
import {list} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";

type TermRow = {slug: string; title: string};
type DefinitionRow = {id: string; body: string; term: string};

class TermView extends FateDataView<TermRow>()("Term")({
	slug: true,
	title: true,
}) {}

class DefinitionView extends FateDataView<DefinitionRow>()("Definition")({
	id: true,
	body: true,
	term: true,
}) {}

/** The kernel views the plugin's schema walk picks up (`isDataView` filter). */
export const termDataView = TermView.view;
export const definitionDataView = DefinitionView.view;

/** The entity types the generated client imports by manifest type name. */
export type Term = Entity<typeof TermView>;
export type Definition = Entity<typeof DefinitionView>;

/** Client-exposed roots (the `views.ts` convention: annotated for nameability). */
export const Root: Record<string, unknown> = {
	term: termDataView,
	// A `list` root with no `orderBy`: the resolver owns ordering, so the option is
	// inert and dropped (#1333). The plugin keys the root's kind on the `list()`
	// wrapper, never on `orderBy`, so this still generates a `list` client root.
	terms: list(termDataView),
};

/** The build-time stand-in for a D1 binding: ANY access throws. */
const d1: Record<string, unknown> = new Proxy(
	{},
	{
		get(_target, property): never {
			throw new Error(`D1 touched at build time: ${String(property)}`);
		},
	},
);

const termSource = Fate.source(
	TermView,
	{id: "slug"},
	{
		byIds: function* (slugs) {
			yield* Effect.sync(() => void d1[slugs.join(",")]);
			const rows: Array<TermRow> = [];
			return rows;
		},
	},
);

const definitionSource = Fate.source(
	DefinitionView,
	{id: "id"},
	{
		byId: function* (id) {
			yield* Effect.sync(() => void d1[id]);
			return null;
		},
	},
);

const queries = {
	term: Fate.query(
		{args: Schema.Struct({slug: Schema.String}), type: TermView},
		Effect.fn("term")(function* ({args}) {
			yield* Effect.sync(() => void d1[args.slug]);
			return null;
		}),
	),
};

const lists = {
	terms: Fate.list(
		{args: Schema.Struct({first: Schema.optional(Schema.Number)}), type: TermView},
		Effect.fn("terms")(function* () {
			yield* Effect.sync(() => void d1.rows);
			const page: ConnectionResult<TermRow> = {
				items: [],
				pagination: {hasNext: false, hasPrevious: false},
			};
			return page;
		}),
	),
};

const mutations = {
	"definition.add": Fate.mutation(
		{input: Schema.Struct({term: Schema.String, body: Schema.String}), type: DefinitionView},
		Effect.fn("definition.add")(function* ({input}) {
			yield* Effect.sync(() => void d1[input.term]);
			const row: DefinitionRow = {id: "def-1", body: input.body, term: input.term};
			return row;
		}),
	),
};

const config = FateServer.config({
	queries,
	lists,
	mutations,
	sources: [termSource, definitionSource],
});

/** What the fate Vite plugin requires: a `fateServer` value with `.manifest`. */
export const fateServer = FateExecutor.toCodegenServer(config);
