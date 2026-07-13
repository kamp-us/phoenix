/**
 * `FateExecutor` — the v1 compiler: config → pure `createFateServer` +
 * `toFetchHandler`.
 *
 * The contract under test, end to end over the wire (fate's own
 * `handleRequest`), driven over the shared sozluk fixture world
 * (`Oracle.fixture.ts` — the same world the differential oracle runs):
 *
 *   1. **A full operation round-trips** — wire request in → Schema decode →
 *      handler (yielding a domain service from the runtime + the captured
 *      build-time services) → wire result out. The domain service is a
 *      mutable in-memory database, and a mutation's write is visible to a
 *      later read through the same runtime.
 *   2. **Failures map through the `FateWireCode` codec** — a declared
 *      annotated error produces its wire code; an undeclared defect produces
 *      `INTERNAL_SERVER_ERROR` with the fixed message (no detail leak).
 *   3. **The per-request pair are ordinary services** — handlers `yield*`
 *      `CurrentUser` / `LivePublisher`; two CONCURRENT requests observe their
 *      own values (a barrier holds both in flight at once).
 *   4. **Oracle-baseline role** — since the v2 cutover (ADR 0043) this
 *      compiled path serves nothing; it exists as the differential oracle's
 *      v1 baseline (the `Interpreter*.test.ts` suites), so this suite keeps pinning its
 *      behavior.
 *   5. **Spans nest under the runtime's request span** (ADR 0041): the
 *      runtime carries `Tracer.ParentSpan`; a handler's `Effect.fn` span —
 *      operation AND source — parents to it, not to a detached root.
 *   6. **One conversion point** — no static `Effect.run*` anywhere in the
 *      package's non-test, non-fixture sources; the ManagedRuntime promise
 *      runner appears exactly once, inside `Executor.ts` (the LLMS.md
 *      integration idiom). Since the v2 cutover the PRODUCTION conversion
 *      point is the platform layer's boundary (alchemy's worker bridge runs
 *      the request fiber) — the package-side runner exists only because
 *      fate's compiled `(args) => Promise` resolvers (the oracle baseline)
 *      demand one. Test-support `*.fixture.ts` modules sit outside the pin:
 *      the oracle harness's v2 backend runs the interpreter on a
 *      harness-owned runtime, standing in for the platform layer.
 */
import {readdir, readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {Context, Effect, Layer, ManagedRuntime, Tracer} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {CompiledFateSources} from "./Compiled.ts";
import {CurrentUser, type CurrentUserInfo} from "./CurrentUser.ts";
import type {FateExecutorRuntime, FateFetchHandler} from "./Executor.ts";
import {compileFateSources} from "./Executor.ts";
import {Fate, FateExecutor} from "./index.ts";
import {LivePublisher} from "./LivePublisher.ts";
import {
	definitionSource,
	recordingPublisher,
	SozlukDb,
	SozlukDbLive,
	sozlukConfig,
	sozlukQueries,
	spanLog,
	TermView,
	termSource,
	user,
} from "./Oracle.fixture.ts";
import type {FateRequestContext} from "./RequestContext.ts";
import type {AnyFateMutation, SourceDefinitionLike} from "./Server.ts";
import {FateServer} from "./Server.ts";

// fate's source executors receive a masking `plan` the adapted handlers only
// read `args` from (connection) or ignore entirely (byId/byIds). Tests don't
// build a real `SourcePlan`; they pass these sentinels for the unused parts —
// the same shape the bridge's isolation tests use (`effect.unit.test.ts`).
const PLAN = undefined as never;
const planWithArgs = (args: Record<string, unknown>) => ({args}) as never;

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

const makeContext = (
	options: {user?: CurrentUserInfo; publisher?: typeof LivePublisher.Service} = {},
): FateRequestContext => ({
	currentUser: {user: options.user},
	livePublisher: options.publisher ?? recordingPublisher().publisher,
});

/**
 * The barrier's promise never rejects, but object-notation `Effect.tryPromise` (the
 * #2736 idiom) requires a `catch` mapping to a tagged error; `orDie` then keeps the
 * handler's error channel `never` (the query declares no errors).
 */
class BarrierRejected extends Schema.TaggedErrorClass<BarrierRejected>()("test/BarrierRejected", {
	cause: Schema.Unknown,
}) {}

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

const defaultLayer = () => FateServer.layer(sozlukConfig).pipe(Layer.provide(SozlukDbLive));

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
				data: {id: "def-1", body: "bir efekt sistemi", term: "effect", author: "umut", votes: 0},
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
				{id: "def-1", body: "bir efekt sistemi", term: "effect", author: "umut", votes: 0},
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

describe("FateExecutor.toFetchHandler — config validation", () => {
	it("a typeless mutation fails the first request with the layer-construction wording", async () => {
		// Hand-built erased entry — `Fate.mutation` makes this unrepresentable;
		// the check lives in `collectConfigIssues`, so the oracle baseline fails
		// through layer construction (toFetchHandler resolves the service on
		// first call) with the SAME wording `FateServer.layer` dies with
		// (Server.test.ts) and `toCodegenServer` throws (Codegen.test.ts).
		const typelessMutation = {
			kind: "mutation",
			definition: {input: Schema.Struct({}), type: "Broken"},
			type: undefined,
			handler: () => Effect.succeed(null),
			resolve: () => Effect.succeed(null),
		} satisfies AnyFateMutation;
		const harness = makeHarness({
			layer: FateServer.layer(FateServer.config({mutations: {"broken.op": typelessMutation}})),
		});
		try {
			await expect(
				harness.handle(
					fateRequest([{id: "1", kind: "query", name: "health", select: []}]),
					makeContext(),
				),
			).rejects.toThrow(/mutation "broken\.op" carries no wire type/);
		} finally {
			await harness.dispose();
		}
	});
});

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

describe("FateExecutor — per-request services", () => {
	it("two concurrent requests observe their own CurrentUser and LivePublisher", async () => {
		const barrier = makeBarrier(2);
		const whoami = Fate.query(
			{type: "Session"},
			Effect.fn("whoami")(function* () {
				const {user: sessionUser} = yield* CurrentUser;
				// Hold until BOTH requests are in flight — the two resolutions overlap. The
				// barrier never rejects, and the query declares no errors (E = never), so a
				// rejection is a defect (orDie) — the faithful object-notation form of the old
				// `Effect.promise` (#2736).
				yield* Effect.tryPromise({
					try: () => barrier.arrive(),
					catch: (cause) => new BarrierRejected({cause}),
				}).pipe(Effect.orDie);
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

describe("compileFateSources", () => {
	it("keys the registry by definition identity and resolves getSource by typeName", async () => {
		const harness = makeHarness({
			layer: FateServer.layer(
				FateServer.config({
					queries: {term: sozlukQueries.term},
					sources: [termSource, definitionSource],
				}),
			).pipe(Layer.provide(SozlukDbLive)),
		});
		try {
			const sources = await compiledSourcesOf(harness);
			// The registry key IS the entry's definition object (fate's identity
			// requirement); each entry's adapted executor lands in the Map.
			expect(executorOf(sources, termSource.definition)).toBeDefined();
			expect(executorOf(sources, definitionSource.definition)).toBeDefined();
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
				FateServer.config({queries: {term: sozlukQueries.term}, sources: [probeSource]}),
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

describe("the single conversion point", () => {
	it("no static Effect.run* in package sources; the runtime runner only in Executor.ts", async () => {
		const srcDir = dirname(fileURLToPath(import.meta.url));
		// Test files and test-support fixture modules sit outside the pin —
		// the oracle harness (`Oracle.fixture.ts`) runs the interpreter on a
		// harness-owned runtime, standing in for the platform layer's request
		// fiber. Everything else in src/ is swept.
		const files = (await readdir(srcDir)).filter(
			(name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".fixture.ts"),
		);
		expect(files).toContain("Executor.ts");
		for (const name of files) {
			const source = await readFile(join(srcDir, name), "utf8");
			// The static runners never appear: every execution flows through the
			// worker-level ManagedRuntime (LLMS.md's integration idiom).
			expect(source, name).not.toMatch(/Effect\.run(Promise|Sync|Fork|Callback)/);
			const conversions = source.match(/\.runPromise(Exit)?\(/g) ?? [];
			if (name === "Executor.ts") {
				// Exactly one conversion point — the compiler's runtime promise
				// runner (oracle-baseline-only since the v2 cutover: the serving
				// path's conversion is the platform layer's, outside the package).
				expect(conversions, name).toHaveLength(1);
			} else {
				expect(conversions, name).toHaveLength(0);
			}
		}
	});
});

describe("FateExecutor — types", () => {
	it("a wider worker runtime satisfies FateExecutorRuntime (contravariant R)", () => {
		expectTypeOf<
			ManagedRuntime.ManagedRuntime<FateServer | SozlukDb, never>
		>().toExtend<FateExecutorRuntime>();
		expectTypeOf(FateExecutor.toFetchHandler).returns.toEqualTypeOf<FateFetchHandler>();
	});
});
