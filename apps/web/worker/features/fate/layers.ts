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
import type {Drizzle, DrizzleDb} from "../../db/Drizzle.ts";
import {makeDrizzleLayer} from "../../db/Drizzle.ts";
import type {LiveBus} from "../fate-live/event-bus.ts";
import {type Pano, PanoLive} from "../pano/Pano.ts";
import type {Auth} from "../pasaport/Auth.ts";
import {
	type Auth as BetterAuthInstance,
	makePasaportLive,
	type Pasaport,
} from "../pasaport/Pasaport.ts";
import {type Sozluk, SozlukLive} from "../sozluk/Sozluk.ts";
import {type Stats, StatsLive} from "../stats/Stats.ts";
import {type Vote, VoteLive} from "../vote/Vote.ts";

/**
 * Every service a fate resolver / source executor may touch — the environment
 * the bridge's generator bodies are checked against. It is the worker-level
 * {@link WorkerFateServices} plus the two genuinely per-request services the
 * bridge provides onto each resolver effect at run time: `Auth` (the validated
 * session) and `LiveBus` (the publish capability, ADR 0039).
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
