/**
 * `AppLive` — the single router layer the worker's `fetch` is compiled from
 * (ADR 0027, `.patterns/alchemy-http-router.md`). Assembles two kinds of routes,
 * both `Layer`s merged into one: a typed-JSON `HttpApiBuilder` group
 * (`GET /api/health`) and raw-`Request` `HttpRouter.add` routes (`POST /fate`,
 * `* /api/auth/*`, live).
 *
 * The raw routes lift their handler's `R` into route-requirement markers that
 * plain `Layer.provide` does NOT discharge — they must be discharged with
 * `HttpRouter.provideRequest` (ADR 0029).
 */
import type * as BetterAuth from "@alchemy.run/better-auth";
import type {FateServer} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import type {WorkerFateServices} from "../features/fate/layers.ts";
import {fateRoute} from "../features/fate/route.ts";
import {liveRoute} from "../features/fate-live/route.ts";
import type {LiveConnections, LiveTopics} from "../features/fate-live/topics.ts";
import {authRoute} from "../features/pasaport/route.ts";
import {rssRoute} from "../features/rss/route.ts";
import {healthApiLayer} from "./health.ts";

/** Build the application router layer. Each option's contract is on its property. */
export const makeAppLive = (options: {
	/**
	 * The worker-level fate services PLUS the composed `FateServer`, as a
	 * DEPENDENCY-FREE context layer (`R = never`): `makeFateRuntime`'s
	 * `contextLayer` from the one per-isolate runtime. No runtime on the request
	 * path (ADR 0043). Pinning `R = never` makes the dual-build state
	 * unrepresentable — raw `makeFateLayer` (`R = Database | BetterAuth`) no
	 * longer typechecks here, so `provideRequest` can never silently construct a
	 * second Drizzle/Pasaport per request (ADR 0041).
	 */
	readonly fateLayer: Layer.Layer<WorkerFateServices | FateServer>;
	/** The worker-init-resolved DO namespace handles (publish + SSE transport). */
	readonly liveLayer: Layer.Layer<LiveTopics | LiveConnections>;
	/**
	 * The `BetterAuth` Layer, dependency-free (`R = never`). In the deployed
	 * worker this is the INIT-RESOLVED `Layer.succeed(...)(betterAuth)`
	 * (`index.ts`) — NOT `BetterAuthLive`: `provideRequest` builds its layer per
	 * request, so passing `BetterAuthLive` would reconstruct better-auth (the
	 * secret resolution needs deploy-time alchemy machinery absent in workerd) on
	 * every request. Tests pass `layerTest` over the same tag; both thread through
	 * `provideRequest` identically.
	 */
	readonly betterAuthLayer: Layer.Layer<BetterAuth.BetterAuth>;
	/**
	 * The worker's ambient `RuntimeContext`, captured in init. better-auth's
	 * `fetch`/`auth` carry it undischarged; `HttpRouter.add` lifts it into the
	 * `/api/auth/*` route's per-request markers and we discharge it here.
	 */
	readonly runtimeContext: BaseRuntimeContext;
}) => {
	const typedJson = healthApiLayer;

	// `provideRequest` discharges the route-requirement markers `HttpRouter.add`
	// lifts (plain `Layer.provide` does not). All four provided layers are
	// dependency-free (`R = never`), so they merge flat.
	const rawRoutes = Layer.mergeAll(fateRoute, authRoute, liveRoute, rssRoute).pipe(
		HttpRouter.provideRequest(
			Layer.mergeAll(
				options.fateLayer,
				options.liveLayer,
				options.betterAuthLayer,
				Layer.succeed(RuntimeContext)(options.runtimeContext),
			),
		),
	);

	return Layer.mergeAll(typedJson, rawRoutes);
};
