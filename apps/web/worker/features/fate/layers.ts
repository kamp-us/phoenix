/**
 * Worker-level fate layers (ADR 0041, supersedes 0029; `.patterns/alchemy-runtime.md`).
 *
 * The departure from phoenix's original per-request `FateRuntime`: there is **no
 * *per-request* `ManagedRuntime`**. `Drizzle` (built once from the bound D1) and
 * the feature services (`Sozluk`, `Pano`, `Vote`, `Pasaport`, `Stats`) are
 * **worker-level layers**, constructed once in the worker init and carried by ONE
 * isolate-level `ManagedRuntime` (the {@link WorkerRuntime}). The `/fate` bridge
 * runs every resolver THROUGH that runtime, providing only the two genuinely
 * per-request services — `Auth` + `LiveBus` — onto each resolver effect
 * (`effect.ts`); the routes that yield a worker service directly take it from the
 * same runtime's built context (`Layer.effectContext`, built in `index.ts` via
 * {@link makeFateRuntime} and consumed by `route.ts`).
 *
 * `FateEnv` is the union of every service a fate resolver or source executor may
 * touch — the environment its generator bodies are checked against.
 *
 * The layer graph (mergeAll / provide / provideMerge) is the one in
 * `.patterns/effect-layer-composition.md`; only *where* it's provided moved,
 * from a per-request runtime to here.
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type {Database} from "../../db/Database.ts";
import type {Drizzle} from "../../db/Drizzle.ts";
import {DrizzleLive} from "../../db/Drizzle.ts";
import type {LiveBus} from "../fate-live/event-bus.ts";
import {type Pano, PanoLive} from "../pano/Pano.ts";
import type {Auth} from "../pasaport/Auth.ts";
import {makePasaportLive, type Pasaport} from "../pasaport/Pasaport.ts";
import {type Sozluk, SozlukLive} from "../sozluk/Sozluk.ts";
import {type Stats, StatsLive} from "../stats/Stats.ts";
import {type Vote, VoteLive} from "../vote/Vote.ts";

/**
 * Every service a fate resolver / source executor may touch — the conceptual
 * authoring environment. It is the worker-level {@link WorkerFateServices} plus
 * the two genuinely per-request services the bridge provides onto each resolver
 * effect at run time: `Auth` (the validated session) and `LiveBus` (the publish
 * capability, ADR 0039) — i.e. exactly the environment of a resolver effect
 * (`WorkerFateServices | Auth | LiveBus`).
 *
 * Post-F4 no signature binds this directly: the bridge casts the generator's
 * erased env to `R` ({@link WorkerFateServices}, the runtime's environment) and
 * provides `Auth`/`LiveBus` per effect. It stays as the named contract a resolver
 * body is authored against (referenced across `.patterns/` and ADR 0041).
 *
 * `HttpServerRequest` is deliberately NOT here: no resolver yields it, and the
 * F4 bridge runs each resolver on the worker `ManagedRuntime` (carrying
 * {@link WorkerFateServices}) rather than capturing the whole HttpRouter context
 * — so the upstream Tag never reaches a resolver. The raw `Request` rides the
 * `FateContext` (`ctx.request`) for the rare resolver that needs headers.
 */
export type FateEnv = WorkerFateServices | Auth | LiveBus;

/**
 * The worker-level services `makeFateLayer` provides — the singletons the worker
 * `ManagedRuntime` carries. The per-request `Auth` + `LiveBus` ({@link FateEnv}
 * minus these) are provided onto each resolver effect by the bridge, not baked
 * into the runtime.
 */
export type WorkerFateServices = Drizzle | Pasaport | Vote | Sozluk | Pano | Stats;

/**
 * The ONE isolate-level `ManagedRuntime` the worker init builds from
 * {@link makeFateLayer} — it carries the {@link WorkerFateServices} singletons and
 * fails for nothing (`E = never`). The `/fate` bridge runs every resolver through
 * it; `route.ts`, `app.ts`, `context.ts`, and the bridge tests all name this exact
 * shape, so it lives here once rather than being re-spelled at each site (ADR 0041).
 */
export type WorkerRuntime = ManagedRuntime.ManagedRuntime<WorkerFateServices, never>;

/**
 * Build the ONE worker-level {@link WorkerRuntime} from a fully-resolved worker
 * layer (`Database`/`BetterAuth` already discharged), plus the route-context layer
 * derived from its built context. The single construction point shared by
 * `index.ts` (the deployed worker), `app.test.ts`, and `run-fate-op.ts` — so the
 * "how" lives here once rather than being re-spelled (and silently varied) at each
 * site.
 *
 * A shared `memoMap` (the effect-smol "Integrating Effect into existing
 * applications" idiom — `ai-docs/src/03_integration/10_managed-runtime.ts`) keeps
 * layer memoization correct across the runtime and the `contextLayer` derived from
 * it: the worker singletons (`Drizzle` + the feature services) are built exactly
 * once and SHARED by both the bridge runtime and the routes that yield a worker
 * service directly (`Pasaport` in the `/fate` route). `contextLayer` reuses the
 * runtime's already-built `Context<WorkerFateServices>` rather than rebuilding the
 * layer per request through `provideRequest`.
 *
 * NEVER DISPOSED IN THE WORKER: a Cloudflare Worker isolate has no shutdown
 * hook, so the deployed worker never calls `runtime.dispose()` — the runtime
 * lives for the isolate's lifetime and Drizzle/D1 holds no poolable socket to
 * release (ADR 0041). That deviation is platform-scoped: the Node test harness
 * (`run-fate-op.ts`) builds a runtime per operation and DOES dispose it after
 * the round-trip. Callers that only need the runtime (no route layer)
 * destructure `{runtime}`.
 */
export const makeFateRuntime = (
	layer: Layer.Layer<WorkerFateServices>,
): {
	readonly runtime: WorkerRuntime;
	readonly contextLayer: Layer.Layer<WorkerFateServices>;
} => {
	const memoMap = Layer.makeMemoMapUnsafe();
	const runtime = ManagedRuntime.make(layer, {memoMap});
	const contextLayer = Layer.effectContext(runtime.contextEffect);
	return {runtime, contextLayer};
};

/**
 * The `Pasaport` layer, sourced from the shared `Database` seam + `BetterAuth`
 * tag. Resolves the better-auth instance from the `BetterAuth` Context tag
 * (`@alchemy.run/better-auth`, implemented by `better-auth-live.ts`) once at
 * layer build, then hands it to {@link makePasaportLive} — Pasaport no longer
 * builds its own auth. Requires `Drizzle` (provided below) + `BetterAuth`.
 *
 * `betterAuth.auth` carries a `RuntimeContext` requirement in its value type
 * (the reference is `Effect<Auth, never, RuntimeContext>`), but phoenix's fork
 * (`better-auth-live.ts`) reads its secret from a `secret_text` binding, not from
 * alchemy's `Random`/`Output` — so resolving the cached instance never actually
 * touches the runtime context. We satisfy the *type* requirement with an inert
 * `RuntimeContext` stub so `makeFateLayer`'s `R` stays exactly `Database |
 * BetterAuth`; the worker still provides the real `RuntimeContext` to the
 * `/api/auth/*` route's `betterAuth.fetch` path through `makeAppLive`.
 *
 * The runtime-safety of this stub is pinned by a focused guard test —
 * `pasaport-from-tag.test.ts` resolves `Pasaport` through this very path over a
 * REAL better-auth fake with only the inert context, and asserts
 * `validateSession` works. The day the fork (or upstream alchemy better-auth)
 * starts reading `RuntimeContext` during `auth` resolution, that test fails
 * in-process instead of a prod session silently mis-resolving.
 */
const inertRuntimeContext: BaseRuntimeContext = {
	Type: "fate-layer",
	id: "fate-layer",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const PasaportFromTag = Layer.unwrap(
	Effect.gen(function* () {
		const betterAuth = yield* BetterAuth.BetterAuth;
		const auth = yield* betterAuth.auth.pipe(
			Effect.provideService(RuntimeContext, inertRuntimeContext),
		);
		return makePasaportLive(auth);
	}),
);

/**
 * The worker-level data-plane layer (ADR 0029, ADR 0040).
 *
 * Zero-arg layer constant: it derives everything from the two seams it requires
 * in its `R` channel — `Database` (the raw d1 handle, behind `DrizzleLive`) and
 * `BetterAuth` (the auth instance, for `Pasaport.validateSession`). No caller
 * threads a concrete `db` or `auth` argument: both `Drizzle` and Pasaport's
 * auth derive from those tags, so features and auth provably share one handle.
 *
 * `Drizzle` is built from {@link DrizzleLive} (sourced from `Database`); the
 * feature services provide over it. `SozlukLive` and `PanoLive` both depend on
 * `Vote`, so they merge first and `provideMerge(VoteLive)` once; `PasaportFromTag`
 * and `StatsLive` depend only on `Drizzle` (Pasaport also on `BetterAuth`).
 *
 * `R = Database | BetterAuth`; the per-request `Auth` + `LiveBus` are provided
 * by the bridge onto each resolver effect (`effect.ts`), not here.
 */
export const makeFateLayer: Layer.Layer<
	WorkerFateServices,
	never,
	Database | BetterAuth.BetterAuth
> = Layer.mergeAll(
	PasaportFromTag,
	Layer.mergeAll(SozlukLive, PanoLive).pipe(Layer.provideMerge(VoteLive)),
	StatsLive,
).pipe(Layer.provideMerge(DrizzleLive));
