/**
 * The task-8 codegen fixture — the module shape `schema.ts` adopts in task 9:
 * definitions at module scope, `FateExecutor.toCodegenServer(config)` exported
 * as `fateServer`, NOTHING executable evaluated at import time.
 *
 * Every handler and source closes over `tripwire` — a Proxy that throws on ANY
 * property access, standing in for a D1 binding that does not exist at build
 * time. `Codegen.test.ts` imports this module dynamically: a successful import
 * + a populated manifest prove the codegen path is construction-only (the
 * spike's "no database at build time" claim), because a single touched handler
 * would throw here, at module evaluation.
 */
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {FateDataView} from "./DataView.ts";
import {FateExecutor} from "./Executor.ts";
import * as Fate from "./Fate.ts";
import {FateServer} from "./Server.ts";

type TermRow = {slug: string; title: string};

class TermView extends FateDataView<TermRow>()("Term")({
	slug: true,
	title: true,
}) {}

/** The build-time stand-in for a database binding: ANY access throws. */
const tripwire: Record<string, unknown> = new Proxy(
	{},
	{
		get(_target, property): never {
			throw new Error(`backing service touched at module evaluation: ${String(property)}`);
		},
	},
);

const termSource = Fate.source(
	TermView,
	{id: "slug"},
	{
		byIds: function* (slugs) {
			yield* Effect.sync(() => void tripwire[slugs.join(",")]);
			const rows: Array<TermRow> = [];
			return rows;
		},
	},
);

const queries = {
	term: Fate.query(
		{args: Schema.Struct({slug: Schema.String}), type: TermView},
		Effect.fn("term")(function* ({args}) {
			yield* Effect.sync(() => void tripwire[args.slug]);
			return null;
		}),
	),
};

const lists = {
	terms: Fate.list(
		{args: Schema.Struct({first: Schema.optional(Schema.Number)}), type: TermView},
		Effect.fn("terms")(function* () {
			yield* Effect.sync(() => void tripwire.rows);
			const page: ConnectionResult<TermRow> = {
				items: [],
				pagination: {hasNext: false, hasPrevious: false},
			};
			return page;
		}),
	),
};

const mutations = {
	"term.add": Fate.mutation(
		{input: Schema.Struct({slug: Schema.String, title: Schema.String}), type: TermView},
		Effect.fn("term.add")(function* ({input}) {
			yield* Effect.sync(() => void tripwire[input.slug]);
			const row: TermRow = {slug: input.slug, title: input.title};
			return row;
		}),
	),
};

const config = FateServer.config({queries, lists, mutations, sources: [termSource]});

/** What `schema.ts` exports for the fate Vite plugin's `runnerImport`. */
export const fateServer = FateExecutor.toCodegenServer(config);
