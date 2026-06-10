/**
 * `FateExecutor` — the v1 compiler: config → pure `createFateServer` +
 * `toFetchHandler` (tasks.md task 7; PRD stories 8, 11).
 *
 * The contract under test, end to end over the wire (fate's own
 * `handleRequest`):
 *
 *   1. **A full operation round-trips** — wire request in → Schema decode →
 *      handler (yielding a domain service from the runtime + the captured
 *      build-time services) → wire result out. T1: the domain service is a
 *      mutable in-memory database, and a mutation's write is visible to a
 *      later read through the same runtime.
 *   2. **Failures map through the `fateWireCode` codec** — a declared
 *      annotated error produces its wire code; an undeclared defect produces
 *      `INTERNAL_SERVER_ERROR` with the fixed message (no detail leak).
 *   3. **The per-request pair are ordinary services** — handlers `yield*`
 *      `CurrentUser` / `LivePublisher`; two CONCURRENT requests observe their
 *      own values (a barrier holds both in flight at once).
 *   4. **Raw legacy records pass through untouched** — a bridge-shaped
 *      promise resolver in the same config receives the SAME ctx object the
 *      route passes (`FateContext` compatibility is identity), alongside
 *      compiled entries in one wire request.
 *   5. **Spans nest under the runtime's request span** (ADR 0041): the
 *      runtime carries `Tracer.ParentSpan`; a handler's `Effect.fn` span —
 *      operation AND source — parents to it, not to a detached root.
 *   6. **One conversion point** — no static `Effect.run*` anywhere in the
 *      package's non-test sources; the ManagedRuntime promise runner appears
 *      exactly once, inside `Executor.ts` (the LLMS.md integration idiom).
 */
import {readdir, readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import type {ConnectionResult} from "@nkzw/fate/server";
import {Context, Effect, Layer, ManagedRuntime, Option, Tracer} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, expectTypeOf, it} from "vitest";
import {CurrentUser, type CurrentUserInfo, Unauthorized} from "./CurrentUser.ts";
import {FateDataView} from "./DataView.ts";
import type {
	CompiledFateSources,
	FateExecutorRuntime,
	FateFetchHandler,
	FateRequestContext,
} from "./Executor.ts";
import {compileFateSources, FateExecutor} from "./Executor.ts";
import {Fate} from "./index.ts";
import {LivePublisher} from "./LivePublisher.ts";
import type {RawFateOperation, SourceDefinitionLike} from "./Server.ts";
import {FateServer} from "./Server.ts";
import {fateWireCode} from "./WireError.ts";

// fate's source executors receive a masking `plan` the adapted handlers only
// read `args` from (connection) or ignore entirely (byId/byIds). Tests don't
// build a real `SourcePlan`; they pass these sentinels for the unused parts —
// the same shape the bridge's isolation tests use (`effect.unit.test.ts`).
const PLAN = undefined as never;
const planWithArgs = (args: Record<string, unknown>) => ({args}) as never;

// --- fixture rows + views ------------------------------------------------------

type TermRow = {
	slug: string;
	title: string;
};

type DefinitionRow = {
	id: string;
	body: string;
	term: string;
	author: string;
};

class TermView extends FateDataView<TermRow>()("Term")({
	slug: true,
	title: true,
}) {}

class DefinitionView extends FateDataView<DefinitionRow>()("Definition")({
	id: true,
	body: true,
	term: true,
	author: true,
}) {}

// --- the in-memory database (the T1 seam: mutable state behind a service) -------

class SozlukDb extends Context.Service<
	SozlukDb,
	{
		readonly terms: Array<TermRow>;
		readonly definitions: Array<DefinitionRow>;
	}
>()("@phoenix/fate-effect/test/SozlukDb") {}

/** A fresh in-memory database per layer build — no row leakage across runtimes. */
const SozlukDbLive = Layer.sync(SozlukDb, () => ({
	terms: [
		{slug: "effect", title: "Effect"},
		{slug: "fate", title: "fate"},
	],
	definitions: [],
}));

// --- fixture error ------------------------------------------------------------

class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
	"test/BodyRequired",
	{message: Schema.String},
	{[fateWireCode]: "BODY_REQUIRED"},
) {}

// --- the wire-driving harness ---------------------------------------------------

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
	// `Response.json()` is `Promise<unknown>` under @types/node; the wire shape
	// is fate's own — parse the text (JSON.parse is `any`, assignment narrows).
	const body: {results: ReadonlyArray<WireResult>} = JSON.parse(await res.text());
	return body.results;
};

/** A recording per-request `LivePublisher` value — every call lands in `calls`. */
const recordingPublisher = (): {
	publisher: typeof LivePublisher.Service;
	calls: Array<string>;
} => {
	const calls: Array<string> = [];
	const push = (line: string) =>
		Effect.sync(() => {
			calls.push(line);
		});
	const publisher: typeof LivePublisher.Service = {
		update: (type, id) => push(`update ${type}:${id}`),
		delete: (type, id) => push(`delete ${type}:${id}`),
		connection: (procedure, args) => ({
			appendNode: (nodeType, id) =>
				push(`append ${procedure}(${JSON.stringify(args ?? {})}) ${nodeType}:${id}`),
			prependNode: (nodeType, id) =>
				push(`prepend ${procedure}(${JSON.stringify(args ?? {})}) ${nodeType}:${id}`),
			deleteEdge: (nodeType, id) =>
				push(`deleteEdge ${procedure}(${JSON.stringify(args ?? {})}) ${nodeType}:${id}`),
			invalidate: () => push(`invalidate ${procedure}(${JSON.stringify(args ?? {})})`),
		}),
	};
	return {publisher, calls};
};

const makeContext = (
	options: {user?: CurrentUserInfo; publisher?: typeof LivePublisher.Service} = {},
): FateRequestContext => ({
	currentUser: {user: options.user},
	livePublisher: options.publisher ?? recordingPublisher().publisher,
});

const user = (id: string): CurrentUserInfo => ({id, email: `${id}@kamp.us`, name: id});

/** Resolve once `count` callers have arrived — holds requests concurrently in flight. */
const makeBarrier = (count: number): {arrive: () => Promise<void>} => {
	const waiters: Array<() => void> = [];
	return {
		arrive: () =>
			new Promise<void>((resolve) => {
				waiters.push(resolve);
				if (waiters.length >= count) {
					for (const release of waiters) {
						release();
					}
				}
			}),
	};
};

// --- span + legacy observation channels ------------------------------------------

const currentSpan = Effect.orDie(Effect.currentSpan);

/** What the probe handlers observed: span name + parent span id. */
const spanLog: Array<{name: string; parent: string | undefined}> = [];

const logSpan = Effect.gen(function* () {
	const span = yield* currentSpan;
	spanLog.push({
		name: span.name,
		parent: Option.isSome(span.parent) ? span.parent.value.spanId : undefined,
	});
});

/** The legacy resolver's observations — proves ctx passthrough by identity. */
const legacySeen: Array<{ctx: unknown; args: unknown; select: unknown}> = [];

const legacyEntry: RawFateOperation = {
	type: "Legacy",
	resolve: (options: {ctx: unknown; input: {args?: unknown}; select: Array<string>}) => {
		legacySeen.push({ctx: options.ctx, args: options.input.args, select: options.select});
		return Promise.resolve({legacy: true});
	},
};

// --- the representative config (decode evidence, errors, live, legacy, sources) --

const termSource = Fate.source(
	TermView,
	{id: "slug"},
	{
		byIds: function* (slugs) {
			yield* logSpan;
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
	// Decode evidence: `take` is FiniteFromString — the wire sends a string,
	// the handler sees a number (the Schema ran before the handler).
	term: Fate.query(
		{
			args: Schema.Struct({slug: Schema.String, take: Schema.optional(Schema.FiniteFromString)}),
			type: TermView,
		},
		Effect.fn("term")(function* ({args}) {
			yield* logSpan;
			const db = yield* SozlukDb;
			const row = db.terms.find((term) => term.slug === args.slug) ?? null;
			return row === null ? null : {...row, take: args.take ?? null};
		}),
	),
	definitions: Fate.query(
		{args: Schema.Struct({term: Schema.String}), type: DefinitionView},
		Effect.fn("definitions")(function* ({args}) {
			const db = yield* SozlukDb;
			return db.definitions.filter((row) => row.term === args.term);
		}),
	),
	// An undeclared defect: the thrown detail must NOT reach the wire.
	boom: Fate.query({type: "Boom"}, () => Effect.die(new Error("secret-db-detail"))),
};

const lists = {
	terms: Fate.list(
		{args: Schema.Struct({first: Schema.optional(Schema.Number)}), type: TermView},
		Effect.fn("terms")(function* ({args}) {
			const db = yield* SozlukDb;
			const take = args.first ?? 10;
			const result: ConnectionResult<TermRow> = {
				items: db.terms.slice(0, take).map((row) => ({cursor: row.slug, node: row})),
				pagination: {hasNext: db.terms.length > take, hasPrevious: false},
			};
			return result;
		}),
	),
};

const mutations = {
	"definition.add": Fate.mutation(
		{
			input: Schema.Struct({term: Schema.String, body: Schema.String}),
			type: DefinitionView,
			error: Schema.Union([Unauthorized, BodyRequired]),
		},
		Effect.fn("definition.add")(function* ({input}) {
			const author = yield* CurrentUser.required;
			if (input.body === "") {
				return yield* new BodyRequired({message: "tanım boş olamaz"});
			}
			const db = yield* SozlukDb;
			const definition: DefinitionRow = {
				id: `def-${db.definitions.length + 1}`,
				body: input.body,
				term: input.term,
				author: author.id,
			};
			db.definitions.push(definition);
			const live = yield* LivePublisher;
			yield* live
				.connection("Term.definitions", {term: input.term})
				.appendNode("Definition", definition.id, {node: definition});
			return definition;
		}),
	),
};

const config = FateServer.config({
	queries: {...queries, legacy: legacyEntry},
	lists,
	mutations,
	sources: [termSource, definitionSource],
});

const defaultLayer = () => FateServer.layer(config).pipe(Layer.provide(SozlukDbLive));

/** One harness = one runtime over a FRESH in-memory database. */
const makeHarness = (options: {layer?: Layer.Layer<FateServer>; requestSpan?: boolean} = {}) => {
	const base = options.layer ?? defaultLayer();
	const layer = options.requestSpan
		? Layer.mergeAll(
				base,
				Layer.succeed(Tracer.ParentSpan)(
					Tracer.externalSpan({spanId: "req-span", traceId: "req-trace"}),
				),
			)
		: base;
	const runtime = ManagedRuntime.make(layer);
	const handle = FateExecutor.toFetchHandler(runtime);
	return {
		runtime,
		handle,
		dispose: () => runtime.dispose(),
	};
};

/** Look an executor up by definition IDENTITY — fate's own registry contract. */
const executorOf = (sources: CompiledFateSources, definition: SourceDefinitionLike) => {
	for (const [key, value] of sources.registry) {
		if (key === definition) {
			return value;
		}
	}
	return undefined;
};

const compiledSourcesOf = async (harness: ReturnType<typeof makeHarness>) => {
	const context = await harness.runtime.context();
	const service = Context.get(context, FateServer);
	return compileFateSources(service.sources, {
		runtime: harness.runtime,
		services: service.services,
	});
};

// --- 1. the full round-trip (T1: in-memory database behind the runtime) ---------

describe("FateExecutor.toFetchHandler — round-trip", () => {
	it("wire request → Schema decode → handler over the runtime's domain service → wire result", async () => {
		const harness = makeHarness();
		try {
			const res = await harness.handle(
				fateRequest([
					{id: "1", kind: "query", name: "term", args: {slug: "effect", take: "2"}, select: []},
				]),
				makeContext(),
			);
			expect(res.status).toBe(200);
			const [result] = await resultsOf(res);
			// The wire sent `take: "2"` (a string); the handler saw the DECODED 2 —
			// the definition's Schema ran between the wire and the handler.
			expect(result).toEqual({
				id: "1",
				ok: true,
				data: {slug: "effect", title: "Effect", take: 2},
			});
		} finally {
			await harness.dispose();
		}
	});

	it("a mutation writes the in-memory database; a later read through the same runtime sees it", async () => {
		const harness = makeHarness();
		const {publisher, calls} = recordingPublisher();
		try {
			const write = await harness.handle(
				fateRequest([
					{
						id: "1",
						kind: "mutation",
						name: "definition.add",
						input: {term: "effect", body: "bir efekt sistemi"},
						select: [],
					},
				]),
				makeContext({user: user("umut"), publisher}),
			);
			const [written] = await resultsOf(write);
			expect(written).toEqual({
				id: "1",
				ok: true,
				data: {id: "def-1", body: "bir efekt sistemi", term: "effect", author: "umut"},
			});
			// The live publish went through the per-request LivePublisher value.
			expect(calls).toEqual(['append Term.definitions({"term":"effect"}) Definition:def-1']);

			const read = await harness.handle(
				fateRequest([
					{id: "2", kind: "query", name: "definitions", args: {term: "effect"}, select: []},
				]),
				makeContext(),
			);
			const [rows] = await resultsOf(read);
			expect(rows?.ok).toBe(true);
			expect(rows?.data).toEqual([
				{id: "def-1", body: "bir efekt sistemi", term: "effect", author: "umut"},
			]);
		} finally {
			await harness.dispose();
		}
	});

	it("a list operation returns fate's ConnectionResult shape", async () => {
		const harness = makeHarness();
		try {
			const res = await harness.handle(
				fateRequest([{id: "1", kind: "list", name: "terms", args: {first: 1}, select: []}]),
				makeContext(),
			);
			const [result] = await resultsOf(res);
			expect(result).toEqual({
				id: "1",
				ok: true,
				data: {
					items: [{cursor: "effect", node: {slug: "effect", title: "Effect"}}],
					pagination: {hasNext: true, hasPrevious: false},
				},
			});
		} finally {
			await harness.dispose();
		}
	});
});

// --- 2. failure mapping through the fateWireCode codec ---------------------------

describe("FateExecutor — wire errors", () => {
	it("a declared annotated error produces its annotated wire code", async () => {
		const harness = makeHarness();
		try {
			const res = await harness.handle(
				fateRequest([
					{
						id: "1",
						kind: "mutation",
						name: "definition.add",
						input: {term: "effect", body: ""},
						select: [],
					},
				]),
				makeContext({user: user("umut")}),
			);
			const [result] = await resultsOf(res);
			expect(result?.ok).toBe(false);
			expect(result?.error?.code).toBe("BODY_REQUIRED");
			expect(result?.error?.message).toBe("tanım boş olamaz");
		} finally {
			await harness.dispose();
		}
	});

	it("CurrentUser.required on an anonymous request produces UNAUTHORIZED", async () => {
		const harness = makeHarness();
		try {
			const res = await harness.handle(
				fateRequest([
					{
						id: "1",
						kind: "mutation",
						name: "definition.add",
						input: {term: "effect", body: "tanım"},
						select: [],
					},
				]),
				makeContext(),
			);
			const [result] = await resultsOf(res);
			expect(result?.ok).toBe(false);
			expect(result?.error?.code).toBe("UNAUTHORIZED");
		} finally {
			await harness.dispose();
		}
	});

	it("invalid mutation input is rejected by the Schema with VALIDATION_ERROR", async () => {
		const harness = makeHarness();
		try {
			const res = await harness.handle(
				fateRequest([
					{id: "1", kind: "mutation", name: "definition.add", input: {term: 1}, select: []},
				]),
				makeContext({user: user("umut")}),
			);
			const [result] = await resultsOf(res);
			expect(result?.ok).toBe(false);
			expect(result?.error?.code).toBe("VALIDATION_ERROR");
		} finally {
			await harness.dispose();
		}
	});

	it("an undeclared defect produces INTERNAL_SERVER_ERROR without leaking details", async () => {
		const harness = makeHarness();
		try {
			const res = await harness.handle(
				fateRequest([{id: "1", kind: "query", name: "boom", select: []}]),
				makeContext(),
			);
			const text = await res.text();
			const body: {results: ReadonlyArray<WireResult>} = JSON.parse(text);
			const [result] = body.results;
			expect(result?.ok).toBe(false);
			expect(result?.error?.code).toBe("INTERNAL_SERVER_ERROR");
			expect(result?.error?.message).toBe("Something went wrong.");
			// The defect's own message never reaches the wire — anywhere in the body.
			expect(text).not.toContain("secret-db-detail");
		} finally {
			await harness.dispose();
		}
	});
});

// --- 3. the per-request pair under concurrency -----------------------------------

describe("FateExecutor — per-request services", () => {
	it("two concurrent requests observe their own CurrentUser and LivePublisher", async () => {
		const barrier = makeBarrier(2);
		const whoami = Fate.query(
			{type: "Session"},
			Effect.fn("whoami")(function* () {
				const {user: sessionUser} = yield* CurrentUser;
				// Hold until BOTH requests are in flight — the two resolutions overlap.
				yield* Effect.promise(() => barrier.arrive());
				const live = yield* LivePublisher;
				const id = sessionUser?.id ?? "anon";
				yield* live.update("Session", id);
				return {id};
			}),
		);
		const harness = makeHarness({
			layer: FateServer.layer(FateServer.config({queries: {whoami}})),
		});
		const a = recordingPublisher();
		const b = recordingPublisher();
		try {
			const [resA, resB] = await Promise.all([
				harness.handle(
					fateRequest([{id: "a", kind: "query", name: "whoami", select: []}]),
					makeContext({user: user("user-a"), publisher: a.publisher}),
				),
				harness.handle(
					fateRequest([{id: "b", kind: "query", name: "whoami", select: []}]),
					makeContext({user: user("user-b"), publisher: b.publisher}),
				),
			]);
			const [resultA] = await resultsOf(resA);
			const [resultB] = await resultsOf(resB);
			expect(resultA?.data).toEqual({id: "user-a"});
			expect(resultB?.data).toEqual({id: "user-b"});
			// Each request's publishes landed on ITS publisher value, not the other's.
			expect(a.calls).toEqual(["update Session:user-a"]);
			expect(b.calls).toEqual(["update Session:user-b"]);
		} finally {
			await harness.dispose();
		}
	});
});

// --- 4. legacy passthrough --------------------------------------------------------

describe("FateExecutor — legacy records", () => {
	it("a bridge-shaped record executes unchanged alongside compiled entries, with the same ctx", async () => {
		const harness = makeHarness();
		const context = makeContext();
		legacySeen.length = 0;
		try {
			const res = await harness.handle(
				fateRequest([
					{id: "1", kind: "query", name: "term", args: {slug: "fate"}, select: []},
					{id: "2", kind: "query", name: "legacy", args: {from: "bridge"}, select: ["legacy"]},
				]),
				context,
			);
			const results = await resultsOf(res);
			expect(results).toEqual([
				{id: "1", ok: true, data: {slug: "fate", title: "fate", take: null}},
				{id: "2", ok: true, data: {legacy: true}},
			]);
			// The legacy resolver received the SAME ctx object the route passed as
			// adapterContext (FateContext compatibility is identity, not a copy),
			// plus its untouched args/select.
			expect(legacySeen).toHaveLength(1);
			expect(legacySeen[0]?.ctx).toBe(context);
			expect(legacySeen[0]?.args).toEqual({from: "bridge"});
			expect(legacySeen[0]?.select).toEqual(["legacy"]);
		} finally {
			await harness.dispose();
		}
	});
});

// --- 5. span nesting (ADR 0041) ---------------------------------------------------

describe("FateExecutor — observability", () => {
	it("operation and source spans nest under the runtime's request span", async () => {
		const harness = makeHarness({requestSpan: true});
		spanLog.length = 0;
		try {
			const res = await harness.handle(
				fateRequest([{id: "1", kind: "query", name: "term", args: {slug: "effect"}, select: []}]),
				makeContext(),
			);
			expect((await resultsOf(res))[0]?.ok).toBe(true);
			// The handler's wire-name span (`Effect.fn("term")`) parented to the
			// runtime's ambient request span — not a detached root (F4/ADR 0041).
			expect(spanLog).toEqual([{name: "term", parent: "req-span"}]);

			// The SOURCE handler's constructor-owned span (`Term.byIds`) nests the
			// same way when its adapted executor runs through the runtime.
			spanLog.length = 0;
			const sources = await compiledSourcesOf(harness);
			const executor = executorOf(sources, termSource.definition);
			const rows = await executor?.byIds?.({ctx: makeContext(), ids: ["effect"], plan: PLAN});
			expect(rows).toEqual([{slug: "effect", title: "Effect"}]);
			expect(spanLog).toEqual([{name: "Term.byIds", parent: "req-span"}]);
		} finally {
			await harness.dispose();
		}
	});
});

// --- sources: identity-keyed registry, adapted + legacy executors ------------------

describe("compileFateSources", () => {
	it("keys the registry by definition identity and resolves getSource by typeName", async () => {
		const legacyExecutor = {byId: () => Promise.resolve(null)};
		const harness = makeHarness({
			layer: FateServer.layer(
				FateServer.config({
					queries: {term: queries.term},
					sources: [
						termSource,
						{definition: definitionSource.definition, executor: legacyExecutor},
					],
				}),
			).pipe(Layer.provide(SozlukDbLive)),
		});
		try {
			const sources = await compiledSourcesOf(harness);
			// The registry key IS the entry's definition object (fate's identity
			// requirement) — for new and legacy entries alike; the legacy executor
			// lands in the Map verbatim.
			expect(executorOf(sources, termSource.definition)).toBeDefined();
			expect(executorOf(sources, definitionSource.definition)).toBe(legacyExecutor);
			// getSource resolves a view OR a definition to the SAME object.
			expect(sources.getSource(termSource.definition.view)).toBe(termSource.definition);
			expect(sources.getSource(termSource.definition)).toBe(termSource.definition);
			expect(() => sources.getSource(definitionSource.definition.view)).not.toThrow();
			expect(() => {
				sources.getSource({...termSource.definition.view, typeName: "Nope"});
			}).toThrow("No source registered for 'Nope'");
		} finally {
			await harness.dispose();
		}
	});

	it("adapts the handlers to fate's executor contract (Array out, page bag in)", async () => {
		const pages: Array<unknown> = [];
		const probeSource = Fate.source(
			TermView,
			{id: "slug"},
			{
				byIds: function* (slugs) {
					const db = yield* SozlukDb;
					return db.terms.filter((row) => slugs.includes(row.slug));
				},
				connection: function* (page) {
					pages.push(page);
					const db = yield* SozlukDb;
					return db.terms.slice(0, page.take);
				},
			},
		);
		const harness = makeHarness({
			layer: FateServer.layer(
				FateServer.config({queries: {term: queries.term}, sources: [probeSource]}),
			).pipe(Layer.provide(SozlukDbLive)),
		});
		try {
			const sources = await compiledSourcesOf(harness);
			const executor = executorOf(sources, probeSource.definition);

			const rows = await executor?.byIds?.({
				ctx: makeContext(),
				ids: ["effect", "missing", "fate"],
				plan: PLAN,
			});
			// The handler's ReadonlyArray became fate's mutable Array; absent rows
			// are absent, not failures.
			expect(Array.isArray(rows)).toBe(true);
			expect(rows).toEqual([
				{slug: "effect", title: "Effect"},
				{slug: "fate", title: "fate"},
			]);

			// fate's connection options map onto the package's page bag: `args`
			// comes from `plan.args`, absent optionals stay absent.
			const connectionRows = await executor?.connection?.({
				ctx: makeContext(),
				cursor: "effect",
				direction: "forward",
				take: 1,
				plan: planWithArgs({termSlug: "effect"}),
			});
			expect(connectionRows).toEqual([{slug: "effect", title: "Effect"}]);
			expect(pages).toEqual([
				{args: {termSlug: "effect"}, cursor: "effect", direction: "forward", take: 1},
			]);
		} finally {
			await harness.dispose();
		}
	});
});

// --- 6. the single conversion point ------------------------------------------------

describe("the single conversion point", () => {
	it("no static Effect.run* in package sources; the runtime runner only in Executor.ts", async () => {
		const srcDir = dirname(fileURLToPath(import.meta.url));
		const files = (await readdir(srcDir)).filter(
			(name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
		);
		expect(files).toContain("Executor.ts");
		for (const name of files) {
			const source = await readFile(join(srcDir, name), "utf8");
			// The static runners never appear: every execution flows through the
			// worker-level ManagedRuntime (LLMS.md's integration idiom).
			expect(source, name).not.toMatch(/Effect\.run(Promise|Sync|Fork|Callback)/);
			const conversions = source.match(/\.runPromise(Exit)?\(/g) ?? [];
			if (name === "Executor.ts") {
				// Exactly one conversion point — the compiler's runtime promise runner.
				expect(conversions, name).toHaveLength(1);
			} else {
				expect(conversions, name).toHaveLength(0);
			}
		}
	});
});

// --- type-level pins ---------------------------------------------------------------

describe("FateExecutor — types", () => {
	it("a wider worker runtime satisfies FateExecutorRuntime (contravariant R)", () => {
		expectTypeOf<
			ManagedRuntime.ManagedRuntime<FateServer | SozlukDb, never>
		>().toExtend<FateExecutorRuntime>();
		expectTypeOf(FateExecutor.toFetchHandler).returns.toEqualTypeOf<FateFetchHandler>();
	});
});
