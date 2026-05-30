/**
 * `AppLive` — the single router layer the worker's `fetch` is compiled from
 * (ADR 0027, `.patterns/alchemy-http-router.md`).
 *
 * Hono is gone. The HTTP surface is assembled here from two kinds of routes:
 *
 *   - **Typed JSON** (`GET /api/health`, the dev-only `/api/admin/*` seeders) —
 *     `HttpApiBuilder` groups with schema-decoded payloads/responses
 *     (`admin-api.ts` / `admin-handlers.ts`).
 *   - **Raw `Request`** (`POST /fate`, `* /api/auth/*`) —
 *     imperative `HttpRouter.add` routes reading `Cloudflare.Request`
 *     (`../fate/route.ts`, `auth-route.ts`).
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
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import type {WorkerAdminServices, WorkerFateServices} from "../fate/layers.ts";
import {liveRoute} from "../fate/live-route.ts";
import type {LiveConnections, LiveTopics} from "../fate/live-topics.ts";
import {fateRoute} from "../fate/route.ts";
import {CloudflareEnv} from "../services/index.ts";
import type {WorkerEnv} from "../shared/worker-env.ts";
import {adminApiLayer, adminAuthLayer} from "./admin-handlers.ts";
import {authRoute} from "./auth-route.ts";

/**
 * Build the application router layer.
 *
 * @param fateLayer    the worker-level fate services (Drizzle + features),
 *                     built once in init — discharges the fate, auth, and live
 *                     routes' service requirements via `HttpRouter.provideRequest`.
 * @param adminLayer   the worker-level admin services (`SozlukAdmin`,
 *                     `PanoAdmin`, `PasaportAdmin`) the seeder groups require.
 * @param adminAllowed the env gate for `AdminAuth` (env === "development").
 * @param env          the typed worker env (`WorkerEnv`), provided to the typed
 *                     group as `CloudflareEnv` so the health probe reads the
 *                     deploy environment off the canonical typed service instead
 *                     of casting the untyped runtime `WorkerEnvironment`.
 * @param liveLayer    the worker-init-resolved DO namespace handles
 *                     (`LiveTopics` for the `/fate` publish path, `LiveConnections`
 *                     for the `/fate/live` SSE transport), built from the bound
 *                     `TopicDO`/`ConnectionDO` namespaces in worker init.
 */
export const makeAppLive = (options: {
	readonly fateLayer: Layer.Layer<WorkerFateServices>;
	readonly adminLayer: Layer.Layer<WorkerAdminServices>;
	readonly adminAllowed: boolean;
	readonly env: WorkerEnv;
	readonly liveLayer: Layer.Layer<LiveTopics | LiveConnections>;
	/**
	 * The `BetterAuth` Layer (`@alchemy.run/better-auth`). In the deployed worker
	 * this is `BetterAuthLive` (`worker/auth/better-auth-live.ts`), which builds
	 * the auth instance via alchemy's `Random` + `D1Connection` — its external
	 * `R` (`Providers`/`Provider<Random>`/`WorkerEnvironment`/`D1ConnectionPolicy`)
	 * is supplied by alchemy's worker runtime context. Tests pass a hand-rolled
	 * Layer over the same tag (`Layer.succeed(BetterAuth.BetterAuth)`); both
	 * shapes thread through `provideRequest` the same way. `R` is left
	 * unconstrained (`any`) so the worker's outer `Effect.provide` discharges
	 * whatever the layer carries upward.
	 */
	readonly betterAuthLayer: Layer.Layer<BetterAuth.BetterAuth, never, any>;
}) => {
	// Typed-JSON groups: health + admin seeders. The group handlers' domain
	// requirements (`AdminAuth` + the admin services for the seeders, `CloudflareEnv`
	// for the health probe) surface as route markers once registered, so they're
	// discharged with `HttpRouter.provideRequest` here — `Layer.provide` does not
	// discharge route markers.
	const typedJson = adminApiLayer.pipe(
		HttpRouter.provideRequest(
			Layer.mergeAll(
				options.adminLayer,
				adminAuthLayer(options.adminAllowed),
				Layer.succeed(CloudflareEnv, options.env),
			),
		),
	);

	// Raw-`Request` routes. `provideRequest` discharges the route-requirement
	// markers `HttpRouter.add` lifts (fate's `FateEnv` subset + `LiveTopics`;
	// `BetterAuth` for `/api/auth/*`; live's `Pasaport` + `LiveConnections`) —
	// plain `Layer.provide` does not. `fateLayer` carries `Pasaport`,
	// `BetterAuthLive` (`worker/auth/better-auth-live.ts`) carries `BetterAuth`,
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
			Layer.mergeAll(options.fateLayer, options.liveLayer).pipe(
				Layer.merge(options.betterAuthLayer),
			),
		),
	);

	return Layer.mergeAll(typedJson, rawRoutes);
};
