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
 * The fate route's worker-level `FateEnv` subset comes from `fateLayer`; the
 * auth route's `Pasaport` comes from the same layer.
 */
import type * as BetterAuth from "@alchemy.run/better-auth";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import * as Layer from "effect/Layer";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import type {WorkerFateServices} from "../features/fate/layers.ts";
import {makeFateRoute} from "../features/fate/route.ts";
import {liveRoute} from "../features/fate-live/route.ts";
import type {LiveConnections, LiveTopics} from "../features/fate-live/topics.ts";
import {authRoute} from "../features/pasaport/route.ts";
import {healthApiLayer} from "./health.ts";

/**
 * Build the application router layer.
 *
 * @param fateRuntime  the isolate's worker `ManagedRuntime` carrying the
 *                     {@link WorkerFateServices} — the `/fate` route runs every
 *                     fate resolver on it (the bridge provides per-request
 *                     `Auth`/`LiveBus` onto each resolver effect, `effect.ts`).
 * @param fateLayer    the worker-level fate services as a route-context layer,
 *                     derived ONCE from `fateRuntime.contextEffect` in init
 *                     (`Layer.effectContext`) — discharges the fate/auth/live
 *                     routes' direct service requirements (`Pasaport` for the
 *                     fate + live routes' session validation) via
 *                     `HttpRouter.provideRequest`. Sharing the runtime's built
 *                     context means the worker services are constructed exactly
 *                     once per isolate, not once for the runtime and once here.
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
	readonly fateRuntime: ManagedRuntime.ManagedRuntime<WorkerFateServices, never>;
	readonly fateLayer: Layer.Layer<WorkerFateServices>;
	readonly liveLayer: Layer.Layer<LiveTopics | LiveConnections>;
	/**
	 * The `BetterAuth` Layer (`@alchemy.run/better-auth`). In the deployed worker
	 * this is `BetterAuthLive` (`worker/features/pasaport/better-auth-live.ts`), which builds
	 * the auth instance via alchemy's `Random` + `D1Connection` — its external
	 * `R` (`Providers`/`Provider<Random>`/`ConfigProvider`/`D1ConnectionPolicy`)
	 * is supplied by alchemy's worker runtime context. Tests pass a hand-rolled
	 * Layer over the same tag (`Layer.succeed(BetterAuth.BetterAuth)`); both
	 * shapes thread through `provideRequest` the same way. `R` is left
	 * unconstrained (`any`) so the worker's outer `Effect.provide` discharges
	 * whatever the layer carries upward.
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
	// markers `HttpRouter.add` lifts (fate's `FateEnv` subset + `LiveTopics`;
	// `BetterAuth` for `/api/auth/*`; live's `Pasaport` + `LiveConnections`) —
	// plain `Layer.provide` does not. `fateLayer` carries `Pasaport`,
	// `BetterAuthLive` (`worker/features/pasaport/better-auth-live.ts`) carries `BetterAuth`,
	// `liveLayer` adds the DO handles.
	// `provideMerge(betterAuthLayer)` instead of a flat 3-way `mergeAll`: with
	// `any` in `betterAuthLayer`'s `R` the effect language service flags the
	// mergeAll as "this layer needs services from another in the same call"
	// (false positive — BetterAuthLive doesn't depend on Pasaport/LiveTopics).
	// `provideMerge` makes the build order explicit: fateLayer + liveLayer
	// first, then betterAuthLayer's outputs merged on top with its own
	// requirements left to the outer worker `Effect.provide`.
	const rawRoutes = Layer.mergeAll(makeFateRoute(options.fateRuntime), authRoute, liveRoute).pipe(
		HttpRouter.provideRequest(
			Layer.mergeAll(
				options.fateLayer,
				options.liveLayer,
				Layer.succeed(RuntimeContext)(options.runtimeContext),
			).pipe(Layer.merge(options.betterAuthLayer)),
		),
	);

	return Layer.mergeAll(typedJson, rawRoutes);
};
