/**
 * Codegen fixture fed to the REAL fate Vite plugin in `codegen-vite.test.ts`. Self-contained
 * (no live feature imports), so it pins the module SHAPE against the plugin, not the live
 * config's content. Handlers close over a throw-on-touch Proxy standing in for D1: if the
 * codegen path executed anything, generation would fail loudly.
 */

import {type Entity, Fate, FateDataView, FateExecutor, FateServer} from "@kampus/fate-effect";
import type {ConnectionResult} from "@nkzw/fate/server";
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

export const termDataView = TermView.view;
export const definitionDataView = DefinitionView.view;

export type Term = Entity<typeof TermView>;
export type Definition = Entity<typeof DefinitionView>;

export const Root: Record<string, unknown> = {
	term: termDataView,
};

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

export const fateServer = FateExecutor.toCodegenServer(config);
