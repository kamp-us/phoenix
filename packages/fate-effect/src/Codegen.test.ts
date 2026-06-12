/**
 * `toCodegenServer` (`Codegen.ts`) — codegen fidelity against the live
 * compiled server.
 *
 * The contract under test:
 *
 *   1. **Manifest equality** — the codegen value's `manifest` deep-equals the
 *      LIVE compiled server's manifest for the same config (`roots: {}` and
 *      the live option mirrored on both sides).
 *   2. **`InferFateAPI` fidelity** — `InferFateAPI<typeof codegenServer>` and
 *      `InferFateAPI<typeof liveServer>` are assignable in BOTH directions for
 *      a representative config (Fate.* entries with args/input Schemas),
 *      where the live reference is fate's own `createFateServer` over real
 *      typed resolvers. Client-facing args/input
 *      are the Schema's ENCODED side — the wire contract, what the client
 *      sends before the server decodes.
 *   3. **Inertness** — building the codegen server runs NOTHING (the fixture
 *      module evaluates under a throw-on-touch Proxy database), and executing
 *      a codegen resolver fails without reaching any service.
 *   4. **Validation parity** — an invalid config (duplicate wire names) throws
 *      the same `FateServerConfigError` the live layer would die with, at
 *      BUILD time.
 */
import type {ConnectionResult, InferFateAPI} from "@nkzw/fate/server";
import {createFateServer} from "@nkzw/fate/server";
import {Context, Effect, Layer, ManagedRuntime} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, expectTypeOf, it} from "vitest";
import {toCodegenServer} from "./Codegen.ts";
import {FateDataView} from "./DataView.ts";
import {compile} from "./Executor.ts";
import {Fate} from "./index.ts";
import type {AnyFateMutation} from "./Server.ts";
import {FateServer, FateServerConfigError} from "./Server.ts";

// --- fixture rows + views ------------------------------------------------------

type TermRow = {
	slug: string;
	title: string;
};

type DefinitionRow = {
	id: string;
	body: string;
	term: string;
};

class TermView extends FateDataView<TermRow>()("Term")({
	slug: true,
	title: true,
}) {}

class DefinitionView extends FateDataView<DefinitionRow>()("Definition")({
	id: true,
	body: true,
	term: true,
}) {}

class SozlukDb extends Context.Service<
	SozlukDb,
	{
		readonly terms: Array<TermRow>;
		readonly definitions: Array<DefinitionRow>;
	}
>()("@phoenix/fate-effect/test/CodegenSozlukDb") {}

const SozlukDbLive = Layer.sync(SozlukDb, () => ({
	terms: [{slug: "effect", title: "Effect"}],
	definitions: [],
}));

// --- the shared wire Schemas (both sides of the comparison name their Encoded) --

const TermArgs = Schema.Struct({
	slug: Schema.String,
	take: Schema.optional(Schema.FiniteFromString),
});
const TermsArgs = Schema.Struct({first: Schema.optional(Schema.Number)});
const AddDefinitionInput = Schema.Struct({term: Schema.String, body: Schema.String});

type TermArgsWire = (typeof TermArgs)["Encoded"];
type TermsArgsWire = (typeof TermsArgs)["Encoded"];
type AddDefinitionWire = (typeof AddDefinitionInput)["Encoded"];

// --- the reference server's adapterContext shape ---------------------------------

/** The reference server's ctx shape — never surfaces in the API types. */
type RefCtx = {requestId: string};

// --- the representative config -------------------------------------------------

const termSource = Fate.source(
	TermView,
	{id: "slug"},
	{
		byIds: function* (slugs) {
			const db = yield* SozlukDb;
			return db.terms.filter((row) => slugs.includes(row.slug));
		},
	},
);

const definitionSource = Fate.source(
	DefinitionView,
	{id: "id"},
	{
		byId: function* (id) {
			const db = yield* SozlukDb;
			return db.definitions.find((row) => row.id === id) ?? null;
		},
	},
);

const queries = {
	term: Fate.query(
		{args: TermArgs, type: TermView},
		Effect.fn("term")(function* ({args}) {
			const db = yield* SozlukDb;
			return db.terms.find((row) => row.slug === args.slug) ?? null;
		}),
	),
	health: Fate.query({type: "Health"}, () => Effect.succeed({ok: true})),
};

const lists = {
	terms: Fate.list(
		{args: TermsArgs, type: TermView},
		Effect.fn("terms")(function* ({args}) {
			const db = yield* SozlukDb;
			const take = args.first ?? 10;
			const page: ConnectionResult<TermRow> = {
				items: db.terms.slice(0, take).map((row) => ({cursor: row.slug, node: row})),
				pagination: {hasNext: db.terms.length > take, hasPrevious: false},
			};
			return page;
		}),
	),
};

const mutations = {
	"definition.add": Fate.mutation(
		{input: AddDefinitionInput, type: DefinitionView},
		Effect.fn("definition.add")(function* ({input}) {
			const db = yield* SozlukDb;
			const definition: DefinitionRow = {
				id: `def-${db.definitions.length + 1}`,
				body: input.body,
				term: input.term,
			};
			db.definitions.push(definition);
			return definition;
		}),
	),
};

const config = FateServer.config({
	queries,
	lists,
	mutations,
	sources: [termSource, definitionSource],
});

// --- the live REFERENCE server (fate's own typing over real resolvers) ----------
//
// What an honest hand-built live fate server declares for the same wire
// contract: resolver args/input typed as the Schemas' Encoded side, outputs as
// the rows the handlers produce. `InferFateAPI` over THIS value is the client
// type the codegen value must reproduce from inert handlers.

const liveQueries = {
	term: {
		type: "Term",
		resolve: (_options: {
			ctx: RefCtx;
			input: {args?: TermArgsWire};
			select: Array<string>;
		}): Promise<TermRow | null> => Promise.resolve(null),
	},
	health: {
		type: "Health",
		resolve: (_options: {
			ctx: RefCtx;
			input: {args?: undefined};
			select: Array<string>;
		}): Promise<{ok: boolean}> => Promise.resolve({ok: true}),
	},
};

const liveLists = {
	terms: {
		type: "Term",
		resolve: (_options: {
			ctx: RefCtx;
			input: {args?: TermsArgsWire};
			select: Array<string>;
		}): Promise<ConnectionResult<TermRow>> =>
			Promise.resolve({items: [], pagination: {hasNext: false, hasPrevious: false}}),
	},
};

const liveMutations = {
	"definition.add": {
		// `as const` keeps the entity literal — fate's MutationAPI reads
		// `Mutations[K]['type']`, and the codegen side preserves the literal
		// (`DefinitionTypeName`), so the reference must too.
		type: "Definition" as const,
		resolve: (_options: {
			ctx: RefCtx;
			input: AddDefinitionWire;
			select: Array<string>;
		}): Promise<DefinitionRow> => Promise.resolve({id: "def-1", body: "", term: ""}),
	},
};

const liveServer = createFateServer<
	RefCtx,
	Record<never, never>,
	typeof liveQueries,
	typeof liveLists,
	typeof liveMutations,
	RefCtx
>({
	roots: {},
	queries: liveQueries,
	lists: liveLists,
	mutations: liveMutations,
	sources: {
		getSource: () => {
			throw new Error("unused — the reference server only exists for its types/manifest");
		},
		registry: new Map(),
	},
});

const codegenServer = toCodegenServer(config);

type CodegenAPI = InferFateAPI<typeof codegenServer>;
type LiveAPI = InferFateAPI<typeof liveServer>;

// --- the wire-driving harness (inertness probe) ----------------------------------

const fateRequest = (operations: ReadonlyArray<Record<string, unknown>>): Request =>
	new Request("https://test.local/fate", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({version: 1, operations}),
	});

interface WireResult {
	readonly ok: boolean;
	readonly id: string;
	readonly data?: unknown;
	readonly error?: {readonly code: string; readonly message?: string};
}

const resultsOf = async (res: Response): Promise<ReadonlyArray<WireResult>> => {
	// `Response.json()` is `Promise<unknown>` under @types/node; parse the text.
	const body: {results: ReadonlyArray<WireResult>} = JSON.parse(await res.text());
	return body.results;
};

// --- 1. manifest equality ---------------------------------------------------------

describe("toCodegenServer — manifest", () => {
	it("equals the live compiled server's manifest for the same config", async () => {
		const runtime = ManagedRuntime.make(FateServer.layer(config).pipe(Layer.provide(SozlukDbLive)));
		try {
			const context = await runtime.context();
			const live = compile(Context.get(context, FateServer), runtime);
			expect(codegenServer.manifest).toEqual(live.manifest);
		} finally {
			await runtime.dispose();
		}
	});

	it("carries the records' wire type names (roots stay empty — ADR 0016/0019)", () => {
		expect(codegenServer.manifest).toEqual({
			lists: {terms: {type: "Term"}},
			live: {},
			mutations: {
				"definition.add": {type: "Definition"},
			},
			queries: {
				health: {type: "Health"},
				term: {type: "Term"},
			},
			types: {},
		});
	});
});

// --- 2. inertness ------------------------------------------------------------------

describe("toCodegenServer — inert handlers", () => {
	it("the codegen module evaluates in bare node without touching any backing service", async () => {
		// The fixture's handlers close over a throw-on-touch Proxy database; a
		// successful dynamic import proves construction runs nothing.
		const fixture = await import("./Codegen.fixture.ts");
		expect(Object.keys(fixture.fateServer.manifest.queries)).toEqual(["term"]);
		expect(fixture.fateServer.manifest.mutations).toEqual({"term.add": {type: "Term"}});
	});

	it("an executed codegen operation fails without reaching any service", async () => {
		const res = await codegenServer.handleRequest(
			fateRequest([{id: "1", kind: "query", name: "term", args: {slug: "effect"}, select: []}]),
		);
		const [result] = await resultsOf(res);
		expect(result?.ok).toBe(false);
	});
});

// --- 3. validation parity ------------------------------------------------------------

describe("toCodegenServer — validation", () => {
	it("an invalid config throws FateServerConfigError at build time (live-init parity)", () => {
		const invalid = FateServer.config({
			queries: {dup: Fate.query({type: "Health"}, () => Effect.succeed({ok: true}))},
			lists: {
				dup: Fate.list({args: TermsArgs, type: "Health"}, () =>
					Effect.succeed({
						items: [],
						pagination: {hasNext: false, hasPrevious: false},
					}),
				),
			},
		});
		expect(() => toCodegenServer(invalid)).toThrow(FateServerConfigError);
		expect(() => toCodegenServer(invalid)).toThrow(/duplicate wire name "dup"/);
	});

	it("a typeless mutation throws at build time with the layer-construction wording", () => {
		// Hand-built erased entry — `Fate.mutation` makes this unrepresentable;
		// the runtime check in `collectConfigIssues` guards non-TS callers. The
		// asserted wording is the SAME string `FateServer.layer` dies with
		// (Server.test.ts) and the oracle baseline rejects with (Executor.test.ts).
		const typelessMutation = {
			kind: "mutation",
			definition: {input: Schema.Struct({}), type: "Broken"},
			type: undefined,
			handler: () => Effect.succeed(null),
			resolve: () => Effect.succeed(null),
		} satisfies AnyFateMutation;
		const invalid = FateServer.config({mutations: {"broken.op": typelessMutation}});
		expect(() => toCodegenServer(invalid)).toThrow(FateServerConfigError);
		expect(() => toCodegenServer(invalid)).toThrow(/mutation "broken\.op" carries no wire type/);
	});
});

// --- 4. InferFateAPI fidelity ---------------------------------------------------------

describe("InferFateAPI fidelity — codegen ≡ live", () => {
	it("the codegen API and the live API are assignable in BOTH directions", () => {
		expectTypeOf<CodegenAPI>().toExtend<LiveAPI>();
		expectTypeOf<LiveAPI>().toExtend<CodegenAPI>();
	});

	it("client-facing args/input are the Schemas' ENCODED side (the wire contract)", () => {
		// `take` is FiniteFromString: the handler sees `number`, the CLIENT sends
		// `string` — the API must surface the encoded side.
		expectTypeOf<CodegenAPI["queries"]["term"]["input"]>().toEqualTypeOf<{
			args?: TermArgsWire;
			select: Array<string>;
		}>();
		expectTypeOf<
			CodegenAPI["mutations"]["definition.add"]["input"]
		>().toEqualTypeOf<AddDefinitionWire>();
		// No declared args Schema → no client args.
		expectTypeOf<CodegenAPI["queries"]["health"]["input"]>().toEqualTypeOf<{
			args?: undefined;
			select: Array<string>;
		}>();
	});

	it("outputs and the mutation entity literal survive the inert construction", () => {
		expectTypeOf<CodegenAPI["queries"]["term"]["output"]>().toEqualTypeOf<TermRow | null>();
		expectTypeOf<CodegenAPI["lists"]["terms"]["output"]>().toEqualTypeOf<
			ConnectionResult<TermRow>
		>();
		expectTypeOf<
			CodegenAPI["mutations"]["definition.add"]["output"]
		>().toEqualTypeOf<DefinitionRow>();
		expectTypeOf<
			CodegenAPI["mutations"]["definition.add"]["entity"]
		>().toEqualTypeOf<"Definition">();
	});
});
