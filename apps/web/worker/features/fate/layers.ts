/**
 * Worker-level fate layers (ADR 0041/0043; `.patterns/alchemy-runtime.md`).
 *
 * There is **no per-request `ManagedRuntime`** — and since the v2 cutover
 * (ADR 0043) no runtime on the request path at all. `Drizzle` (built once
 * from the bound D1) and the feature services (`Sozluk`, `Pano`, `Vote`,
 * `Pasaport`, `Stats`) are **worker-level layers**, constructed once in the
 * worker init and carried by ONE isolate-level `ManagedRuntime` (the
 * {@link WorkerRuntime}). That runtime is the LAYER-BUILD VEHICLE: the
 * routes take everything — the worker singletons AND the composed
 * `FateServer` service — from its built context (`Layer.effectContext` via
 * {@link makeFateRuntime}, discharged per request by
 * `HttpRouter.provideRequest` in `http/app.ts`); the `/fate` route yields
 * `FateInterpreter.handleRequest` on the request fiber, which provides the
 * per-request pair (`CurrentUser`, `LivePublisher`) onto each handler
 * effect itself.
 *
 * The layer graph (mergeAll / provide / provideMerge) is the one in
 * `.patterns/effect-layer-composition.md`; only *where* it's provided moved,
 * from a per-request runtime to here.
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import {FateServer} from "@phoenix/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type {Database} from "../../db/Database.ts";
import type {Drizzle} from "../../db/Drizzle.ts";
import {DrizzleLive} from "../../db/Drizzle.ts";
import {type Pano, PanoLive} from "../pano/Pano.ts";
import {karmaBumpStatement} from "../pasaport/karma.ts";
import {makePasaportLive, type Pasaport} from "../pasaport/Pasaport.ts";
import {type Sozluk, SozlukLive} from "../sozluk/Sozluk.ts";
import {type Stats, StatsLive} from "../stats/Stats.ts";
import {KarmaBump, type Vote, VoteLive} from "../vote/Vote.ts";
import {fateConfig} from "./config.ts";

/**
 * The worker-level services `makeFateLayer` provides — the singletons the worker
 * `ManagedRuntime` carries. The per-request pair (`CurrentUser` + `LivePublisher`,
 * the package's documented request contract) is provided onto each handler
 * effect by the interpreter per request, not baked into the runtime.
 */
export type WorkerFateServices = Drizzle | Pasaport | Vote | Sozluk | Pano | Stats;

/**
 * The ONE isolate-level `ManagedRuntime` the worker init builds from
 * {@link PhoenixFateLive} — it carries the {@link WorkerFateServices} singletons
 * PLUS the composed `FateServer` service and fails for nothing (`E = never`).
 * Init-only wiring — the layer-build vehicle, no request runs through it (the
 * module doc owns that story). The T2 harness (`run-fate-op.ts`)
 * still runs the interpreter program through a per-op runtime of this shape.
 */
export type WorkerRuntime = ManagedRuntime.ManagedRuntime<WorkerFateServices | FateServer, never>;

/**
 * Build the ONE worker-level {@link WorkerRuntime} from a fully-resolved fate
 * layer (typically {@link PhoenixFateLive} with `Database`/`BetterAuth`
 * provided — the worker singletons + the `FateServer` service), plus the
 * route-context layer derived from its built context. The single construction
 * point shared by `index.ts` (the deployed worker), `app.test.ts`, and
 * `run-fate-op.ts` — so the "how" lives here once rather than being re-spelled
 * (and silently varied) at each site.
 *
 * A shared `memoMap` (the effect-smol "Integrating Effect into existing
 * applications" idiom — `ai-docs/src/03_integration/10_managed-runtime.ts`) keeps
 * layer memoization correct across the runtime and the `contextLayer` derived from
 * it: the worker singletons (`Drizzle` + the feature services) are built exactly
 * once and SHARED by every route through the one built context. `contextLayer`
 * carries the runtime's already-built `Context<WorkerFateServices | FateServer>`
 * — what the routes consume instead of rebuilding layers per request (the
 * module doc's runtime story).
 *
 * NEVER DISPOSED IN THE WORKER: a Cloudflare Worker isolate has no shutdown
 * hook, so the deployed worker never calls `runtime.dispose()` — the runtime
 * lives for the isolate's lifetime and Drizzle/D1 holds no poolable socket to
 * release (ADR 0041). That deviation is platform-scoped: the Node test harness
 * (`run-fate-op.ts`) builds a runtime per operation and DOES dispose it after
 * the round-trip. Callers that only need the runtime (no route layer)
 * destructure `{runtime}`; the deployed worker destructures `{contextLayer}`.
 */
export const makeFateRuntime = (
	layer: Layer.Layer<WorkerFateServices | FateServer>,
): {
	readonly runtime: WorkerRuntime;
	readonly contextLayer: Layer.Layer<WorkerFateServices | FateServer>;
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
 * Pasaport's implementation of the `KarmaBump` contract VOTE owns (dependency
 * inversion at the layer seam): the statement Vote
 * batches when a cast lands is pasaport's `karmaBumpStatement` (an UPDATE on
 * `user_profile.total_karma`). Wired HERE — the composition root — so the
 * `vote/ → pasaport/` arrow exists only at this seam, never inside Vote.
 * Künye later swaps this provided value for a DO-backed bump without
 * touching Vote.
 */
const KarmaBumpFromPasaport = Layer.succeed(KarmaBump, {statement: karmaBumpStatement});

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
 * `Vote`, so they merge first and `provideMerge(VoteLive)` once — with Vote's
 * own `KarmaBump` contract discharged by {@link KarmaBumpFromPasaport} right
 * there (`Layer.provide`, not `provideMerge`: the contract is Vote's internal
 * seam, not a worker service the routes see). `PasaportFromTag` and
 * `StatsLive` depend only on `Drizzle` (Pasaport also on `BetterAuth`).
 *
 * `R = Database | BetterAuth`; the per-request pair (`CurrentUser` +
 * `LivePublisher`) is provided onto each handler effect by the interpreter
 * per request, not here.
 */
export const makeFateLayer: Layer.Layer<
	WorkerFateServices,
	never,
	Database | BetterAuth.BetterAuth
> = Layer.mergeAll(
	PasaportFromTag,
	Layer.mergeAll(SozlukLive, PanoLive).pipe(
		Layer.provideMerge(VoteLive),
		Layer.provide(KarmaBumpFromPasaport),
	),
	StatsLive,
).pipe(Layer.provideMerge(DrizzleLive));

/**
 * The composed fate-server layer (`.patterns/fate-effect-server.md`):
 * `FateServer.layer(fateConfig)` over the worker-level domain layers — what
 * {@link makeFateRuntime} builds the one isolate runtime from.
 *
 * `provideMerge` (not `provide`) keeps the {@link WorkerFateServices} in the
 * layer's output alongside `FateServer`: the routes still yield worker services
 * directly (the runtime-derived `contextLayer`). `FateServer.layer`'s own R —
 * the union of `Fate.*` handler/source requirements minus the per-request
 * pair — is discharged by the same domain layers, so a record needing a
 * forgotten service is a compile error HERE, the composition site.
 *
 * `R = Database | BetterAuth` exactly as {@link makeFateLayer}'s — provided in
 * worker init from the init-resolved seams.
 */
export const PhoenixFateLive: Layer.Layer<
	WorkerFateServices | FateServer,
	never,
	Database | BetterAuth.BetterAuth
> = FateServer.layer(fateConfig).pipe(Layer.provideMerge(makeFateLayer));
