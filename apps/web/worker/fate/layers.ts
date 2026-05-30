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
import {Layer} from "effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type {Drizzle, DrizzleDb} from "../db/Drizzle.ts";
import {makeDrizzleLayer} from "../db/Drizzle.ts";
import {type Pano, PanoLive} from "../features/pano/Pano.ts";
import {type PanoAdmin, PanoAdminLive} from "../features/pano/PanoAdmin.ts";
import type {Auth} from "../features/pasaport/Auth.ts";
import {
	type Auth as BetterAuthInstance,
	makePasaportLive,
	type Pasaport,
} from "../features/pasaport/Pasaport.ts";
import {type PasaportAdmin, PasaportAdminLive} from "../features/pasaport/PasaportAdmin.ts";
import {type Sozluk, SozlukLive} from "../features/sozluk/Sozluk.ts";
import {type SozlukAdmin, SozlukAdminLive} from "../features/sozluk/SozlukAdmin.ts";
import {type Stats, StatsLive} from "../features/stats/Stats.ts";
import {type Vote, VoteLive} from "../features/vote/Vote.ts";

/**
 * Every service available inside a fate resolver / source executor. This is the
 * type parameter of the `Context` the `/fate` route captures and the bridge
 * provides — `Auth` + `HttpServerRequest` are supplied per request, the rest are
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
	| HttpServerRequest.HttpServerRequest;

/**
 * The worker-level services `makeFateLayer` provides — the `FateEnv` minus the
 * two per-request services (`Auth`, `HttpServerRequest`) the `/fate` route
 * layers on itself.
 */
export type WorkerFateServices = Drizzle | Pasaport | Vote | Sozluk | Pano | Stats;

/**
 * Build the worker-level data-plane layer from the bound D1.
 *
 * `Drizzle` is built once from `db` (via {@link makeDrizzleLayer}); the feature
 * services provide over it. `SozlukLive` and `PanoLive` both depend on `Vote`,
 * so they merge first and `provideMerge(VoteLive)` once; `PasaportLive` and
 * `StatsLive` depend only on `Drizzle`. Pasaport's better-auth instance is
 * resolved in worker init via the `BetterAuth` Context tag (`@alchemy.run/better-auth`,
 * implemented by `worker/features/pasaport/better-auth-live.ts`) and threaded
 * in through `makePasaportLive(auth)` — Pasaport no longer builds its own auth.
 *
 * The result requires nothing (`R = never`); the per-request `Auth` +
 * `HttpServerRequest` are layered on top in the `/fate` route, not here.
 */
export const makeFateLayer = (
	db: DrizzleDb,
	auth: BetterAuthInstance,
): Layer.Layer<WorkerFateServices> => {
	const DrizzleLayer = makeDrizzleLayer(db);

	const PasaportLive = makePasaportLive(auth);
	const SozlukPanoLayer = Layer.mergeAll(SozlukLive, PanoLive).pipe(Layer.provideMerge(VoteLive));
	const FeatureLayer = Layer.mergeAll(PasaportLive, SozlukPanoLayer, StatsLive);

	return FeatureLayer.pipe(Layer.provideMerge(DrizzleLayer));
};

/**
 * The worker-level admin services — the "admin layer set" of the request/admin
 * split (ADR 0012). `SozlukAdmin`, `PanoAdmin`, and `PasaportAdmin` each depend
 * only on `Drizzle`, built once over the same bound D1 as {@link makeFateLayer}.
 * `AdminAuth` is provided per route in the HTTP layer (env gate), not here.
 */
export type WorkerAdminServices = SozlukAdmin | PanoAdmin | PasaportAdmin;

/**
 * Build the worker-level admin-services layer from the bound D1. Same `Drizzle`
 * construction as {@link makeFateLayer}; the result requires nothing
 * (`R = never`). The seeder HTTP groups (`http/admin-handlers.ts`) provide over
 * it.
 */
export const makeAdminLayer = (db: DrizzleDb): Layer.Layer<WorkerAdminServices> =>
	Layer.mergeAll(SozlukAdminLive, PanoAdminLive, PasaportAdminLive).pipe(
		Layer.provide(makeDrizzleLayer(db)),
	);
