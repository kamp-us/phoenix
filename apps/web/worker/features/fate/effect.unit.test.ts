/**
 * Bridge isolation tests — the fate ↔ Effect seam over ONE worker-level
 * `ManagedRuntime` (the F4 refactor, ADR 0041, supersedes 0029).
 *
 * These verify the bridge through its public wrappers in isolation — no workerd,
 * no real D1, no fate server — driving each helper exactly as fate does:
 * `await wrapped({ctx, input, select})`.
 *
 * The seam: a worker-level `ManagedRuntime` carries the worker services; the
 * per-request `Auth` + `LiveBus` service VALUES ride on the `FateContext` and are
 * provided onto EACH resolver effect at run time (not baked into the runtime).
 * Tests build a tiny marker runtime from a `Marker`-service layer (+ a tracer
 * parent span for the F4 span-nesting test), wrap a `FateContext` around it, and
 * assert observable behavior through the public helpers.
 *
 * The seven behaviors under test:
 *   ① resolver runs on the injected runtime (yields a `Marker` only the runtime
 *      provides) and returns its value.
 *   ② tagged domain failure → `encodeFateError` wire code.
 *   ③ `FateRequestError` passes through verbatim (not re-encoded).
 *   ④ defect (uncaught throw) → `Cause.squash` → `encodeFateError` →
 *      `INTERNAL_SERVER_ERROR`.
 *   ⑤ per-request `Auth` carried by the `FateContext` reaches the resolver (NOT
 *      the runtime).
 *   ⑥ per-request `LiveBus` carried by the `FateContext` reaches the resolver and
 *      publishes (the capturing bus records the resolved topic key).
 *   ⑦ F4: a resolver span nests under the runtime's request span; the OLD
 *      default-runtime path (no parent span) is a detached root.
 */

import {FateRequestError, liveEntityTopic} from "@nkzw/fate/server";
import {Context, Effect, Exit, Layer, ManagedRuntime, Option, Tracer} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, it} from "vitest";
import {LiveBus, liveBusFor} from "../fate-live/event-bus";
import {Auth, Unauthorized} from "../pasaport/Auth";
import type {FateContext} from "./context";
import {fateMutation, fateQuery, fateSource} from "./effect";

// A domain tagged error whose `_tag` `encodeFateError` knows.
class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()("sozluk/BodyRequired", {
	message: Schema.String,
}) {}

// A marker service that ONLY the worker-level runtime provides — yielding it from
// a resolver proves the resolver ran on the injected runtime (behavior ①).
class Marker extends Context.Service<Marker, {readonly value: string}>()(
	"@phoenix/test/fate/Marker",
) {}

/**
 * A capturing per-request `LiveBus` VALUE: the publisher runs the real
 * `topicsForPublish` (inside `makeLiveBus`) so it captures the *resolved* topic
 * keys, recording each into the returned `published` array. Built via
 * `liveBusFor(captureFn)` — the per-request VALUE form the bridge provides onto
 * each effect, matching how `route.ts` / `run-fate-op.ts` build the bus.
 */
const liveBusCapture = (): {
	readonly liveBus: typeof LiveBus.Service;
	readonly published: ReadonlyArray<string>;
} => {
	const published: Array<string> = [];
	const liveBus = liveBusFor((topicKey) => {
		published.push(topicKey);
	});
	return {liveBus, published};
};

/**
 * Build a `FateContext` over a worker-level marker `ManagedRuntime` carrying the
 * `Marker` service, plus the per-request `Auth` + `LiveBus` VALUES. The bridge
 * provides `auth`/`liveBus` onto each resolver effect and runs it on the runtime.
 * Generic in `Marker` — no cast, thanks to `FateContext<R>`.
 */
const makeCtx = (
	opts: {
		user?: {id: string};
		liveBus?: typeof LiveBus.Service;
		marker?: string;
		signal?: AbortSignal;
	} = {},
): FateContext<Marker> => {
	const runtime = ManagedRuntime.make(Layer.succeed(Marker)({value: opts.marker ?? "marker"}));
	const auth: typeof Auth.Service = {user: opts.user as never, session: undefined};
	const liveBus = opts.liveBus ?? liveBusFor(() => {});
	const request = new Request("http://test/fate", opts.signal ? {signal: opts.signal} : {});
	return {runtime, request, auth, liveBus};
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
	// ① resolver runs on the injected runtime & returns a value.
	it("runs the resolver on the injected runtime (yields a runtime-only service)", async () => {
		const resolve = fateQuery<undefined, {value: string}>(function* () {
			const marker = yield* Marker;
			return {value: marker.value};
		});
		await expect(invoke(resolve, makeCtx({marker: "from-runtime"}))).resolves.toEqual({
			value: "from-runtime",
		});
	});

	// ② tagged error → encodeFateError wire code.
	it("maps a tagged domain failure to its FateRequestError wire code", async () => {
		const resolve = fateQuery<undefined, never>(function* () {
			return yield* new BodyRequired({message: "tanım boş olamaz"});
		});
		const err = await invoke(resolve, makeCtx()).catch((e) => e);
		expect(err).toBeInstanceOf(FateRequestError);
		expect(err.code).toBe("BODY_REQUIRED");
		expect(err.message).toBe("tanım boş olamaz");
	});

	// ③ FateRequestError passthrough (not re-encoded).
	it("passes a pre-built FateRequestError through verbatim (not re-encoded)", async () => {
		const sentinel = new FateRequestError("NOT_FOUND", "nope");
		const resolve = fateQuery<undefined, never>(function* () {
			return yield* Effect.fail(sentinel);
		});
		const err = await invoke(resolve, makeCtx()).catch((e) => e);
		expect(err).toBe(sentinel);
	});

	// ④ defect → Cause.squash → encodeFateError → INTERNAL_SERVER_ERROR.
	it("squashes a defect (uncaught throw) → encodeFateError → INTERNAL_SERVER_ERROR", async () => {
		const resolve = fateQuery<undefined, never>(function* () {
			yield* Effect.void;
			throw new Error("boom");
		});
		const err = await invoke(resolve, makeCtx()).catch((e) => e);
		expect(err).toBeInstanceOf(FateRequestError);
		expect(err.code).toBe("INTERNAL_SERVER_ERROR");
	});

	// ④b signal-interrupt SURFACES — it is NOT silently swallowed into a success.
	//    The bridge wires `ctx.request.signal` into `runPromiseExit({signal})`, so a
	//    disconnected client aborts the resolver fiber. The resulting Exit is a pure
	//    interrupt Cause (no `Fail` reason) → `findErrorOption` is `None` → the
	//    `onNone` branch `Cause.squash`es it (yielding effect's
	//    "All fibers interrupted without error") → `encodeFateError` →
	//    `INTERNAL_SERVER_ERROR`. The guarantee under test is that an aborted request
	//    THROWS (surfaces) rather than resolving to an empty/undefined value — i.e.
	//    the interrupt does not vanish silently. (Regression guard: if `onNone` ever
	//    stops throwing, an aborted request would silently resolve `undefined`.)
	it("surfaces a signal interrupt as a throw — an aborted request never resolves silently", async () => {
		const aborted = AbortSignal.abort();
		// A resolver that would never complete on its own, so the only way the promise
		// settles is via the abort-driven interrupt.
		const resolve = fateQuery<undefined, never>(function* () {
			return yield* Effect.never;
		});
		const settled = await invoke(resolve, makeCtx({signal: aborted})).then(
			(value) => ({tag: "resolved" as const, value}),
			(error) => ({tag: "threw" as const, error}),
		);
		// The load-bearing assertion: it THREW (surfaced), it did not resolve silently.
		expect(settled.tag).toBe("threw");
		if (settled.tag === "threw") {
			expect(settled.error).toBeInstanceOf(FateRequestError);
			expect(settled.error.code).toBe("INTERNAL_SERVER_ERROR");
		}
	});

	// ⑤ per-request Auth carried by the FateContext reaches the resolver (NOT the
	//    runtime): the session rides on the ctx, the marker runtime carries no Auth.
	it("sees the per-request Auth session carried by the FateContext, not the runtime", async () => {
		const resolve = fateQuery<undefined, {id: string}>(function* () {
			const {user} = yield* Auth.required;
			return {id: user.id};
		});
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

	// ⑥ per-request LiveBus carried by the FateContext reaches the resolver and
	//    publishes (the capturing bus records the resolved topic key).
	it("sees the per-request LiveBus carried by the FateContext and publishes through it", async () => {
		const {liveBus, published} = liveBusCapture();
		const resolve = fateMutation<{id: string}, {ok: true}>(function* ({input}) {
			const bus = yield* LiveBus;
			yield* bus.useIgnore((b) => b.update("Definition", input.id, {changed: ["score"]}));
			return {ok: true};
		});
		await expect(
			resolve({ctx: makeCtx({liveBus}), input: {id: "t1"}, select: []}),
		).resolves.toEqual({ok: true});
		// The capturing bus on the ctx recorded the resolved topic key — proves the
		// per-request bus VALUE (not a runtime singleton) was provided onto the effect.
		expect(published).toEqual([liveEntityTopic("Definition", "t1")]);
	});

	// ⑦ F4 span-nesting: a resolver span nests under the runtime's request span;
	//    the OLD default-runtime path (no parent span) is a detached root.
	it("nests a resolver span under the runtime's request span (F4) — old path is detached", async () => {
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
			liveBus: liveBusFor(() => {}),
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
