/**
 * Bridge isolation tests — the fate ↔ Effect seam over ONE worker-level
 * `ManagedRuntime` (the F4 refactor).
 *
 * These verify the bridge through its public wrappers in isolation — no workerd,
 * no real D1, no fate server — driving each helper exactly as fate does:
 * `await wrapped({ctx, input, select})`.
 *
 * The seam: a worker-level `ManagedRuntime` carries the worker services; the
 * per-request `Auth` + `LiveBus` service VALUES ride on the `FateContext` and are
 * provided onto EACH resolver effect at run time (not baked into the runtime).
 * Tests build a tiny test runtime from a marker-service layer (+ a tracer for the
 * span-nesting test), wrap a `FateContext` around it, and assert observable
 * behavior through the public helpers.
 */

import {FateRequestError} from "@nkzw/fate/server";
import {Context, Data, Effect, Exit, Layer, ManagedRuntime, Option, Tracer} from "effect";
import {describe, expect, it} from "vitest";
import {LiveBus, makeLiveBusTest} from "../fate-live/event-bus";
import {Auth, Unauthorized} from "../pasaport/Auth";
import type {FateContext} from "./context";
import {fateMutation, fateQuery, fateSource} from "./effect";

// A domain tagged error whose `_tag` `encodeFateError` knows.
class BodyRequired extends Data.TaggedError("sozluk/BodyRequired")<{
	readonly message: string;
}> {}

// A marker service that ONLY the worker-level runtime provides — yielding it from
// a resolver proves the resolver ran on the injected runtime (behavior ①).
class Marker extends Context.Service<Marker, {readonly value: string}>()(
	"@phoenix/test/fate/Marker",
) {}

/**
 * Build a `FateContext` over a worker-level `ManagedRuntime` carrying the
 * `Marker` service, plus the per-request `Auth` + `LiveBus` VALUES. The bridge
 * provides `Auth`/`LiveBus` onto each resolver effect and runs it on the runtime.
 */
const makeCtx = (
	opts: {user?: {id: string}; liveBus?: typeof LiveBus.Service; marker?: string} = {},
): FateContext<Marker> => {
	const runtime = ManagedRuntime.make(Layer.succeed(Marker)({value: opts.marker ?? "marker"}));
	const auth: typeof Auth.Service = {
		user: opts.user as never,
		session: undefined,
	};
	const liveBus = opts.liveBus ?? makeLiveBusTest().service;
	return {runtime, request: new Request("http://test/fate"), auth, liveBus};
};

const invoke = <A, R>(
	fn: (o: {ctx: FateContext<R>; input: {args?: undefined}; select: Array<string>}) => Promise<A>,
	ctx: FateContext<R>,
): Promise<A> => fn({ctx, input: {args: undefined}, select: []});

// fate's source handlers receive a `plan` (the masking plan) that the bridge
// wrapper ignores — it just runs the generator. Tests don't build a real plan,
// so they pass this sentinel for the unused field.
const PLAN = undefined as never;

describe("fateQuery", () => {
	it("runs the resolver on the injected runtime (yields a runtime service)", async () => {
		const resolve = fateQuery<undefined, {value: string}>(function* () {
			const marker = yield* Marker;
			return {value: marker.value};
		});
		await expect(invoke(resolve, makeCtx({marker: "from-runtime"}))).resolves.toEqual({
			value: "from-runtime",
		});
	});

	it("throws encodeFateError(tagged error) — the wire-shaped FateRequestError", async () => {
		const resolve = fateQuery<undefined, never>(function* () {
			return yield* new BodyRequired({message: "tanım boş olamaz"});
		});
		const err = await invoke(resolve, makeCtx()).catch((e) => e);
		expect(err).toBeInstanceOf(FateRequestError);
		expect(err.code).toBe("BODY_REQUIRED");
		expect(err.message).toBe("tanım boş olamaz");
	});

	it("passes a pre-built FateRequestError through verbatim (not re-encoded)", async () => {
		const sentinel = new FateRequestError("NOT_FOUND", "nope");
		const resolve = fateQuery<undefined, never>(function* () {
			return yield* Effect.fail(sentinel);
		});
		const err = await invoke(resolve, makeCtx()).catch((e) => e);
		expect(err).toBe(sentinel);
	});

	it("squashes a defect (uncaught throw) → encodeFateError → INTERNAL_SERVER_ERROR", async () => {
		const resolve = fateQuery<undefined, never>(function* () {
			yield* Effect.void;
			throw new Error("boom");
		});
		const err = await invoke(resolve, makeCtx()).catch((e) => e);
		expect(err).toBeInstanceOf(FateRequestError);
		expect(err.code).toBe("INTERNAL_SERVER_ERROR");
	});

	it("sees the per-request Auth session carried by the FateContext (not the runtime)", async () => {
		const resolve = fateQuery<undefined, {id: string}>(function* () {
			const {user} = yield* Auth.required;
			return {id: user.id};
		});
		// The session rides on the ctx, NOT the runtime layer — proves Auth is
		// provided onto the resolver effect per request.
		await expect(invoke(resolve, makeCtx({user: {id: "u1"}}))).resolves.toEqual({id: "u1"});
	});

	it("an anonymous per-request Auth → Unauthorized → UNAUTHORIZED wire code", async () => {
		const resolve = fateQuery<undefined, {id: string}>(function* () {
			const {user} = yield* Auth.required;
			return {id: user.id};
		});
		const err = await invoke(resolve, makeCtx()).catch((e) => e);
		expect(err).toBeInstanceOf(FateRequestError);
		expect(err.code).toBe("UNAUTHORIZED");
	});

	it("sees the per-request LiveBus carried by the FateContext and publishes through it", async () => {
		const bus = makeLiveBusTest();
		const resolve = fateMutation<{id: string}, {ok: true}>(function* ({input}) {
			const liveBus = yield* LiveBus;
			yield* liveBus.useIgnore((b) => b.update("Definition", input.id, {changed: ["score"]}));
			return {ok: true};
		});
		await expect(
			resolve({ctx: makeCtx({liveBus: bus.service}), input: {id: "t1"}, select: []}),
		).resolves.toEqual({ok: true});
		// The capturing bus on the ctx recorded the resolved topic key — proves the
		// per-request bus VALUE (not a runtime singleton) was provided onto the effect.
		expect(bus.published.length).toBeGreaterThan(0);
		expect(bus.published).toContain("entity:Definition:t1");
	});

	it("nests a resolver span under the runtime's request span (F4 win) — old path is detached", async () => {
		// The worker runtime carries a "request span" as its ambient parent
		// (`Tracer.ParentSpan`). Because the bridge runs each resolver THROUGH the
		// runtime, a resolver's `Effect.withSpan` parents to it.
		const requestSpan = Tracer.externalSpan({spanId: "req-span", traceId: "req-trace"});
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(Marker)({value: "marker"}),
				Layer.succeed(Tracer.ParentSpan)(requestSpan),
			),
		);
		const ctx: FateContext<Marker | Tracer.ParentSpan> = {
			runtime,
			request: new Request("http://test/fate"),
			auth: {user: undefined, session: undefined},
			liveBus: makeLiveBusTest().service,
		};

		// A resolver that opens its own span and returns it — observable through the
		// bridge exactly as a value would be.
		const resolve = fateQuery<undefined, Tracer.Span>(function* () {
			return yield* Effect.currentSpan.pipe(Effect.withSpan("resolver"));
		});
		const span = await invoke(resolve, ctx);

		// F4: the resolver span's PARENT is the runtime's request span.
		expect(Option.isSome(span.parent)).toBe(true);
		expect(Option.getOrThrow(span.parent).spanId).toBe("req-span");

		// Contrast — the OLD bridge path: `Effect.runPromiseExit(Effect.provide(
		// probe, servicesOnlyContext))` on the default runtime, with a services-only
		// Context that carries NO parent span. The resolver span is a DETACHED root.
		const servicesOnly = Context.make(Marker, {value: "marker"});
		const probe = Effect.currentSpan.pipe(Effect.withSpan("resolver"));
		const exit = await Effect.runPromiseExit(Effect.provide(probe, servicesOnly));
		const detached = Exit.isSuccess(exit) ? exit.value : undefined;
		expect(detached).toBeDefined();
		expect(Option.isNone(detached!.parent)).toBe(true);
	});
});

describe("fateMutation", () => {
	it("resolves the Effect's success value", async () => {
		const resolve = fateMutation<{n: number}, number>(function* ({input}) {
			yield* Effect.void;
			return input.n * 2;
		});
		await expect(resolve({ctx: makeCtx(), input: {n: 3}, select: []})).resolves.toBe(6);
	});

	it("maps a tagged failure to its wire code", async () => {
		const resolve = fateMutation<Record<never, never>, never>(function* () {
			return yield* new Unauthorized({message: "no"});
		});
		const err = await resolve({ctx: makeCtx(), input: {}, select: []}).catch((e) => e);
		expect(err.code).toBe("UNAUTHORIZED");
	});
});

describe("fateSource", () => {
	it("byId resolves a raw row through the runtime", async () => {
		const executor = fateSource<{id: string; name: string}, Marker>({
			byId: function* (id) {
				yield* Effect.void;
				return {id, name: `row-${id}`};
			},
		});
		const row = await executor.byId?.({ctx: makeCtx(), id: "x", plan: PLAN});
		expect(row).toEqual({id: "x", name: "row-x"});
	});

	it("byIds returns a mutable array (spread) of rows", async () => {
		const executor = fateSource<{id: string}, Marker>({
			byIds: function* (ids) {
				yield* Effect.void;
				return ids.map((id) => ({id}));
			},
		});
		const rows = await executor.byIds?.({ctx: makeCtx(), ids: ["a", "b"], plan: PLAN});
		expect(rows).toEqual([{id: "a"}, {id: "b"}]);
		expect(Array.isArray(rows)).toBe(true);
	});

	it("maps a failing source executor to a wire error", async () => {
		const executor = fateSource<{id: string}, Marker>({
			byId: function* () {
				return yield* new Unauthorized({message: "no"});
			},
		});
		const err = await executor.byId?.({ctx: makeCtx(), id: "x", plan: PLAN}).catch((e) => e);
		expect(err.code).toBe("UNAUTHORIZED");
	});

	it("only defines the handlers that were provided", () => {
		const executor = fateSource<{id: string}, Marker>({
			byId: function* (id) {
				yield* Effect.void;
				return {id};
			},
		});
		expect(executor.byId).toBeTypeOf("function");
		expect(executor.byIds).toBeUndefined();
		expect(executor.connection).toBeUndefined();
	});
});
