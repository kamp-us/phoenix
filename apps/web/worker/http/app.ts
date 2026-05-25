/**
 * `AppLive` — the single router layer the worker's `fetch` is compiled from
 * (ADR 0027, `.patterns/alchemy-http-router.md`).
 *
 * Hono is gone. The HTTP surface is assembled here from two kinds of routes:
 *
 *   - **Typed JSON** (`GET /api/health`, the dev-only `/api/admin/*` seeders) —
 *     `HttpApiBuilder` groups with schema-decoded payloads/responses
 *     (`admin-api.ts` / `admin-handlers.ts`).
 *   - **Raw `Request`** (`POST /fate`, `* /api/auth/*`, `* /agents/*`) —
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
 * auth/agents routes' `Pasaport` comes from the same layer.
 */
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import type {WorkerAdminServices, WorkerFateServices} from "../fate/layers.ts";
import {fateRoute} from "../fate/route.ts";
import {adminApiLayer, adminAuthLayer} from "./admin-handlers.ts";
import {agentsRoute, authRoute} from "./auth-route.ts";

/**
 * Build the application router layer.
 *
 * @param fateLayer    the worker-level fate services (Drizzle + features),
 *                     built once in init — discharges the fate and auth routes'
 *                     requirements via `HttpRouter.provideRequest`.
 * @param adminLayer   the worker-level admin services (`SozlukAdmin`,
 *                     `PanoAdmin`, `PasaportAdmin`) the seeder groups require.
 * @param adminAllowed the env gate for `AdminAuth` (env === "development").
 */
export const makeAppLive = (options: {
	readonly fateLayer: Layer.Layer<WorkerFateServices>;
	readonly adminLayer: Layer.Layer<WorkerAdminServices>;
	readonly adminAllowed: boolean;
}) => {
	// Typed-JSON groups: health + admin seeders. The group handlers' domain
	// requirements (`AdminAuth` + the admin services) surface as route markers
	// once registered, so they're discharged with `HttpRouter.provideRequest`
	// here — `Layer.provide` does not discharge route markers. `WorkerEnvironment`
	// (health) is worker-provided and stays in `R`.
	const typedJson = adminApiLayer.pipe(
		HttpRouter.provideRequest(
			Layer.mergeAll(options.adminLayer, adminAuthLayer(options.adminAllowed)),
		),
	);

	// Raw-`Request` routes. `provideRequest(fateLayer)` discharges the
	// route-requirement markers `HttpRouter.add` lifts (fate's `FateEnv` subset,
	// auth's `Pasaport`) — plain `Layer.provide` does not.
	const rawRoutes = Layer.mergeAll(fateRoute, authRoute, agentsRoute).pipe(
		HttpRouter.provideRequest(options.fateLayer),
	);

	return Layer.mergeAll(typedJson, rawRoutes);
};
