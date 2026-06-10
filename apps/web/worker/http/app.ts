/**
 * `AppLive` — the single router layer the worker's `fetch` is compiled from
 * (ADR 0027, `.patterns/alchemy-http-router.md`).
 *
 * Hono is gone. The HTTP surface is assembled here from two kinds of routes:
 *
 *   - **Typed JSON** (`GET /api/health`) — an `HttpApiBuilder` group with a
 *     schema-encoded response (`health.ts`).
 *   - **Raw `Request`** (`POST /fate`, `* /api/auth/*`) —
 *     imperative `HttpRouter.add` routes reading `Cloudflare.Request`
 *     (`../features/fate/route.ts`, `auth-route.ts`).
 *
 * Everything is a `Layer`, so they merge into one `AppLive`. The worker compiles
 * it with `HttpRouter.toHttpEffect(AppLive)` for its `fetch`.
 *
 * `HttpRouter.add` routes lift their handler's `R` into route-requirement
 * markers that plain `Layer.provide` does NOT discharge — they must be
 * discharged with `HttpRouter.provideRequest` (see task-2 notes / ADR 0029).
 * The fate route's worker-service subset comes from `fateLayer`; the
 * auth route's `Pasaport` comes from the same layer.
 */
import type * as BetterAuth from "@alchemy.run/better-auth";
import type {FateServer} from "@phoenix/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import type {WorkerFateServices} from "../features/fate/layers.ts";
import {fateRoute} from "../features/fate/route.ts";
import {liveRoute} from "../features/fate-live/route.ts";
import type {LiveConnections, LiveTopics} from "../features/fate-live/topics.ts";
import {authRoute} from "../features/pasaport/route.ts";
import {healthApiLayer} from "./health.ts";

/**
 * Build the application router layer.
 *
 * @param fateLayer    the worker-level fate services (Drizzle + features) PLUS
 *                     the composed `FateServer` service as a dependency-free
 *                     context layer derived from the one per-isolate runtime
 *                     (`makeFateRuntime`'s `contextLayer`) — discharges the
 *                     fate, auth, and live routes' service requirements via
 *                     `HttpRouter.provideRequest`.
 * @param liveLayer    the worker-init-resolved DO namespace handles
 *                     (`LiveTopics` for the `/fate` publish path, `LiveConnections`
 *                     for the `/fate/live` SSE transport), built from the bound
 *                     unified `LiveDO` namespace in worker init.
 *
 * The health probe reads `ENVIRONMENT` via `yield* AppConfig` (the single
 * `effect/Config` surface), off the `ConfigProvider` alchemy auto-wires at worker
 * scope, so this layer no longer needs the worker env passed in.
 */
export const makeAppLive = (options: {
	/**
	 * The worker-level fate services PLUS the composed `FateServer` service as
	 * a DEPENDENCY-FREE context layer (`R = never`): `makeFateRuntime`'s
	 * `contextLayer`, derived from the one per-isolate runtime whose
	 * `Database`/`BetterAuth` seams were provided at construction. The `/fate`
	 * route's interpreter program (`FateInterpreter.handleRequest`) takes
	 * `FateServer` from here — no runtime on the request path (ADR 0043).
	 * Pinning `R = never` makes the dual-build state unrepresentable — raw
	 * `makeFateLayer` (whose `R` is `Database | BetterAuth`) no longer
	 * typechecks here, so `provideRequest` can never silently construct a
	 * second Drizzle/Pasaport per request (ADR 0041).
	 */
	readonly fateLayer: Layer.Layer<WorkerFateServices | FateServer>;
	readonly liveLayer: Layer.Layer<LiveTopics | LiveConnections>;
	/**
	 * The `BetterAuth` Layer (`@alchemy.run/better-auth`). In the deployed worker
	 * this is `BetterAuthLive` (`worker/features/pasaport/better-auth-live.ts`), which builds
	 * the auth instance from the `Database` seam (the raw d1 handle) + the
	 * `BETTER_AUTH_SECRET` binding — its external `R` (the `ConfigProvider` the
	 * secret is read through) is supplied by alchemy's worker runtime context.
	 * Tests pass a hand-rolled Layer over the same tag
	 * (`Layer.succeed(BetterAuth.BetterAuth)`); both shapes thread through
	 * `provideRequest` the same way. `R` is left unconstrained (`any`) so the
	 * worker's outer `Effect.provide` discharges whatever the layer carries upward.
	 */
	readonly betterAuthLayer: Layer.Layer<BetterAuth.BetterAuth, never, any>;
	/**
	 * The worker's ambient `RuntimeContext`, captured in init. better-auth's
	 * `fetch`/`auth` carry an undischarged `RuntimeContext` requirement (the
	 * reference type is `HttpEffect<RuntimeContext>`) that `HttpRouter.add` lifts
	 * into the `/api/auth/*` route's per-request markers; we discharge it here by
	 * providing the isolate's own runtime context to the request layer.
	 */
	readonly runtimeContext: BaseRuntimeContext;
}) => {
	// Typed-JSON group: the `GET /api/health` probe. Its `ConfigProvider`
	// requirement (from `yield* AppConfig`) is satisfied at worker scope (alchemy
	// auto-wires it), so the layer carries no per-request markers to discharge here.
	const typedJson = healthApiLayer;

	// Raw-`Request` routes. `provideRequest` discharges the route-requirement
	// markers `HttpRouter.add` lifts (the fate route's worker services +
	// `FateServer` + `LiveTopics`; `BetterAuth` for `/api/auth/*`; live's
	// `Pasaport` + `LiveConnections`) — plain `Layer.provide` does not.
	// `fateLayer` carries `Pasaport` AND `FateServer`, `BetterAuthLive`
	// (`worker/features/pasaport/better-auth-live.ts`) carries `BetterAuth`,
	// `liveLayer` adds the DO handles.
	// `provideMerge(betterAuthLayer)` instead of a flat 3-way `mergeAll`: with
	// `any` in `betterAuthLayer`'s `R` the effect language service flags the
	// mergeAll as "this layer needs services from another in the same call"
	// (false positive — BetterAuthLive doesn't depend on Pasaport/LiveTopics).
	// `provideMerge` makes the build order explicit: fateLayer + liveLayer
	// first, then betterAuthLayer's outputs merged on top with its own
	// requirements left to the outer worker `Effect.provide`.
	const rawRoutes = Layer.mergeAll(fateRoute, authRoute, liveRoute).pipe(
		HttpRouter.provideRequest(
			Layer.mergeAll(
				options.fateLayer,
				options.liveLayer,
				Layer.succeed(RuntimeContext)(options.runtimeContext),
			).pipe(
				// `provideMerge` the `BetterAuth` seam the auth route needs; its own
				// upstream requirements (`Providers`/`RuntimeContext`) are left for the
				// worker's outer `Effect.provide`. `fateLayer` is dependency-free
				// (runtime-derived, `R = never`), so no `Database` is provided here.
				Layer.provideMerge(options.betterAuthLayer),
			),
		),
	);

	return Layer.mergeAll(typedJson, rawRoutes);
};
