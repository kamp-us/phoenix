/**
 * Worker-level fate layers (ADR 0029, `.patterns/alchemy-runtime.md`).
 *
 * The departure from phoenix's original per-request `FateRuntime`: there is **no
 * per-request `ManagedRuntime`**. `Drizzle` (built once from the bound D1) and
 * the feature services (`Sozluk`, `Pano`, `Vote`, `Pasaport`, `Stats`) are
 * **worker-level layers**, constructed once in the worker init and provided onto
 * the worker body. Per request the `/fate` route provides only `Auth` +
 * `HttpServerRequest` (see `route.ts`) and captures the live service map with
 * `Effect.context<FateEnv>()`.
 *
 * `FateEnv` is the union of every service a fate resolver or source executor may
 * touch — the type parameter of the captured `Context` the bridge runs against.
 *
 * The layer graph (mergeAll / provide / provideMerge) is the one in
 * `.patterns/effect-layer-composition.md`; only *where* it's provided moved,
 * from a per-request runtime to here.
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
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
 * Every service available inside a fate resolver / source executor. This is the
 * type parameter of the `Context` the `/fate` route captures and the bridge
 * provides — `Auth` + `LiveBus` + `HttpServerRequest` are supplied per request
 * (`LiveBus` is the per-request publish capability, ADR 0039), the rest are
 * worker-level singletons. `HttpServerRequest` is the upstream effect Tag
 * (`effect/unstable/http/HttpServerRequest`) the alchemy worker runtime
 * provides — it carries `headers`, `url`, `method` directly, so the hand-rolled
 * `RequestContext` Tag is gone.
 */
export type FateEnv =
	| Drizzle
	| Pasaport
	| Vote
	| Sozluk
	| Pano
	| Stats
	| Auth
	| LiveBus
	| HttpServerRequest.HttpServerRequest;

/**
 * The worker-level services `makeFateLayer` provides — the `FateEnv` minus the
 * two per-request services (`Auth`, `HttpServerRequest`) the `/fate` route
 * layers on itself.
 */
export type WorkerFateServices = Drizzle | Pasaport | Vote | Sozluk | Pano | Stats;

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
 * `R = Database | BetterAuth`; the per-request `Auth` + `HttpServerRequest` are
 * layered on top in the `/fate` route, not here.
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
