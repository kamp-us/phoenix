/**
 * `AppLive` — the single router layer the worker's `fetch` is compiled from
 * (ADR 0027, `.patterns/alchemy-http-router.md`). Assembles two kinds of routes,
 * both `Layer`s merged into one: a typed-JSON `HttpApiBuilder` group
 * (`GET /api/health`) and the raw-`Request` `HttpRouter.add` routes, which come
 * from the worker-owned-route manifest (`worker-routes.ts`) that `index.ts` also
 * derives `runWorkerFirst` from — one source, so route and SPA-shadow glob can't
 * drift (#861).
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
import type {LiveConnections, LiveTopics} from "../features/fate-live/topics.ts";
import {FlagsDevOverrideLive} from "../features/flagship/Flags.ts";
import type {Flagship} from "../features/flagship/Flagship.ts";
import {healthApiLayer} from "./health.ts";
import {rawWorkerRouteLayers} from "./worker-routes.ts";

/** Build the application router layer. Each option's contract is on its property. */
export const makeAppLive = (options: {
	/**
	 * The worker-level fate services PLUS the composed `FateServer`, as a
	 * DEPENDENCY-FREE context layer (`R = never`): `makeFateRuntime`'s
	 * `contextLayer` from the one per-isolate runtime. No runtime on the request
	 * path (ADR 0043). Pinning `R = never` makes the dual-build state
	 * unrepresentable — raw `makeFateLayer` (`R = Database | BetterAuth | Flagship | RuntimeContext`) no
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
	/**
	 * The init-resolved Effect-native `FlagshipClient`, dependency-free
	 * (`R = never`) — `Layer.succeed(Flagship)(client)` from `index.ts` (epic
	 * #488). The health route reads one flag through it so a system-tier test can
	 * prove the binding resolves end-to-end; the flag Effect service lands in #508.
	 */
	readonly flagshipLayer: Layer.Layer<Flagship>;
}) => {
	// The health route's only worker-level requirement is the `Flagship` client
	// (its `ConfigProvider` is auto-wired at worker scope); discharge it here.
	const typedJson = healthApiLayer.pipe(Layer.provide(options.flagshipLayer));

	// The `Flags` domain service over the init-resolved `Flagship` client (#508):
	// isolate-level, so it's built once here from `flagshipLayer` and provided into
	// the per-request set. The probe route reads it; `getBoolean`'s `FlagsContext`
	// is supplied inline by the handler from the session, so it isn't wired here.
	// The local-override wrapper is installed UNCONDITIONALLY (#2741): it is a no-op
	// unless the per-request `FlagsContext.overrides` is populated, which
	// `makeRequestFlagsContext` does only when the request is authorized (dev, or an
	// admin with `phoenix-admin-console` on) — so a deployed non-admin read is
	// byte-identical to the plain `FlagsLive`.
	const flagsLayer = FlagsDevOverrideLive.pipe(Layer.provide(options.flagshipLayer));

	// `provideRequest` discharges the route-requirement markers `HttpRouter.add`
	// lifts (plain `Layer.provide` does not). All provided layers are
	// dependency-free (`R = never`), so they merge flat.
	const rawRoutes = Layer.mergeAll(...rawWorkerRouteLayers).pipe(
		HttpRouter.provideRequest(
			Layer.mergeAll(
				options.fateLayer,
				options.liveLayer,
				options.betterAuthLayer,
				flagsLayer,
				Layer.succeed(RuntimeContext)(options.runtimeContext),
			),
		),
	);

	return Layer.mergeAll(typedJson, rawRoutes);
};
