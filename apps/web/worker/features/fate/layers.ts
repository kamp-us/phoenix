/**
 * Worker-level fate layers (ADR 0041/0043;
 * `.patterns/fate-effect-worker-wiring.md`).
 *
 * There is no runtime on the request path. The feature services are worker-level
 * layers built once in worker init and carried by ONE isolate-level
 * `ManagedRuntime` ({@link WorkerRuntime}) that acts purely as the LAYER-BUILD
 * VEHICLE: routes take the built context off it (discharged per request by
 * `HttpRouter.provideRequest`), and the interpreter provides the per-request pair
 * (`CurrentUser`, `LivePublisher`) onto each handler effect itself. The layer
 * graph is `.patterns/effect-layer-composition.md`; only *where* it's provided
 * moved here, from a per-request runtime.
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import {type AgentAuthority, CurrentActor, type RelationStore} from "@kampus/authz";
import {FateServer} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type {Database} from "../../db/Database.ts";
import type {Drizzle} from "../../db/Drizzle.ts";
import {DrizzleLive} from "../../db/Drizzle.ts";
import {type Flags, FlagsLive} from "../flagship/Flags.ts";
import type {Flagship} from "../flagship/Flagship.ts";
import {AgentAuthorityV1} from "../kunye/AgentAuthorityV1.ts";
import {type Kunye, KunyeLive} from "../kunye/Kunye.ts";
import {RelationStoreLive} from "../kunye/RelationStore.ts";
import {type Bookmark, BookmarkLive} from "../pano/Bookmark.ts";
import {type Pano, PanoLive} from "../pano/Pano.ts";
import {karmaBumpStatement} from "../pasaport/karma.ts";
import {makePasaportLive, type Pasaport} from "../pasaport/Pasaport.ts";
import {type Report, ReportLive} from "../report/Report.ts";
import {type Search, SearchLive} from "../search/Search.ts";
import {type Sozluk, SozlukLive} from "../sozluk/Sozluk.ts";
import {type Stats, StatsLive} from "../stats/Stats.ts";
import {KarmaBump, type Vote, VoteLive} from "../vote/Vote.ts";
import {fateConfig} from "./config.ts";

export type WorkerFateServices =
	| Drizzle
	| Pasaport
	| Vote
	| Sozluk
	| Pano
	| Stats
	| Search
	| Report
	| Bookmark
	| Flags
	// The authz ports the moderation gate discharges against (ADR 0107): the
	// `moderates` relation read (`RelationStoreLive` ← D1) and the dormant
	// agent-attenuation seam (`AgentAuthorityV1`). `CurrentActor` is NOT here —
	// it is per-request, registered separately below.
	| RelationStore
	| AgentAuthority
	// Künye standing (ADR 0107 §4) — the earned-authorship read side. Mounted now
	// that the çaylak sandbox (#1205) is its first consumer (`Kunye.tierOf` decides
	// sandbox-on-create); previously declared but dormant.
	| Kunye;

export type WorkerRuntime = ManagedRuntime.ManagedRuntime<WorkerFateServices | FateServer, never>;

/**
 * Build the ONE worker-level {@link WorkerRuntime} plus the route-context layer
 * derived from its built context. The single construction point shared by
 * `index.ts` and `app.test.ts`.
 *
 * The shared `memoMap` (effect-smol "Integrating Effect into existing
 * applications" idiom, `ai-docs/src/03_integration/10_managed-runtime.ts`) keeps
 * memoization correct across the runtime and the `contextLayer` derived from it:
 * the worker singletons are built exactly once and shared by every route.
 *
 * NEVER DISPOSED IN THE WORKER: a Cloudflare isolate has no shutdown hook, so the
 * deployed worker never calls `runtime.dispose()` and Drizzle/D1 holds no poolable
 * socket to release (ADR 0041).
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
 * `betterAuth.auth` carries a `RuntimeContext` requirement in its type, but
 * phoenix's fork (`better-auth-live.ts`) reads its secret from a `secret_text`
 * binding, never from the runtime context — so we satisfy the *type* with an
 * inert stub to keep `makeFateLayer`'s `R` exactly `Database | BetterAuth`. The
 * worker still provides the real `RuntimeContext` to `/api/auth/*` via `makeAppLive`.
 *
 * The stub's runtime-safety is pinned by `pasaport-from-tag.test.ts`: if the fork
 * (or an alchemy better-auth dep bump) ever reads `RuntimeContext` during `auth`
 * resolution, that test fails in-process instead of a prod session silently
 * mis-resolving — the fix then is to widen `R`, not delete the test.
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
 * Pasaport's implementation of the `KarmaBump` contract Vote owns (dependency
 * inversion). Wired HERE — the composition root — so the `vote/ → pasaport/`
 * arrow exists only at this seam, never inside Vote; künye later swaps this for a
 * DO-backed bump without touching Vote.
 */
const KarmaBumpFromPasaport = Layer.succeed(KarmaBump, {statement: karmaBumpStatement});

/**
 * The worker-level data-plane layer (ADR 0029, ADR 0040). Derives everything from
 * the two seams in its `R` channel — `Database` (behind `DrizzleLive`) and
 * `BetterAuth` — so features and auth provably share one handle.
 *
 * `SozlukLive` and `PanoLive` both depend on `Vote`, so they merge first and
 * `provideMerge(VoteLive)` once — with Vote's `KarmaBump` discharged by
 * {@link KarmaBumpFromPasaport} via `Layer.provide` (not `provideMerge`: the
 * contract is Vote's internal seam, not a worker service the routes see).
 *
 * `PanoLive` also depends on `Bookmark` (it stamps the `isSaved` viewer scalar
 * from `Bookmark.readMine` alongside `myVote`), so `BookmarkLive` joins the same
 * group via `provideMerge` — discharging Pano's requirement while keeping
 * `Bookmark` in {@link WorkerFateServices} for the routes that resolve it directly.
 */
export const makeFateLayer: Layer.Layer<
	WorkerFateServices,
	never,
	Database | BetterAuth.BetterAuth | Flagship | RuntimeContext
> = Layer.mergeAll(
	Layer.mergeAll(SozlukLive, PanoLive).pipe(
		Layer.provideMerge(VoteLive),
		Layer.provideMerge(BookmarkLive),
		Layer.provide(KarmaBumpFromPasaport),
	),
	StatsLive,
	// SearchLive and ReportLive depend only on Drizzle (the FTS read / the report
	// write), so they merge flat alongside the other domain layers and are
	// discharged by `provideMerge(DrizzleLive)`.
	SearchLive,
	ReportLive,
	// The authz ports the moderation gate (`report.resolve`/`restore`/`listOpen`)
	// discharges `Moderate.over(platform)` against: `RelationStoreLive` reads the
	// `moderates` tuple off the same `Drizzle` seam (discharged below), and
	// `AgentAuthorityV1` fills the dormant agent-attenuation port fail-closed.
	RelationStoreLive,
	AgentAuthorityV1,
	// Künye standing (ADR 0107 §4), the çaylak sandbox's tier source (#1205). Reads
	// through `Pasaport`, discharged by the `provideMerge(PasaportFromTag)` below
	// (which keeps `Pasaport` an output for the routes too).
	KunyeLive,
	// `Flags` is the dark-ship read surface the pano draft-save gate consumes (#746).
	// `FlagsLive` needs only `Flagship` (a new R seam, discharged at the composition
	// root like `Database`); `getBoolean`'s `RuntimeContext`/`FlagsContext` are per-call,
	// supplied by the resolver, not at layer build.
	FlagsLive,
).pipe(Layer.provideMerge(PasaportFromTag), Layer.provideMerge(DrizzleLive));

/**
 * The composed fate-server layer (`.patterns/fate-effect-server.md`):
 * `FateServer.layer(fateConfig)` over the domain layers — what
 * {@link makeFateRuntime} builds the one isolate runtime from.
 *
 * `provideMerge` (not `provide`) keeps the {@link WorkerFateServices} in the
 * output alongside `FateServer` so routes still yield them directly; and because
 * `FateServer.layer`'s own R is discharged by the same domain layers, a record
 * needing a forgotten service is a compile error HERE, the composition site.
 *
 * `[CurrentActor]` registers the per-request authz actor (ADR 0107 §7): it is
 * excluded from build-time R and fulfilled per request from the session in
 * `route.ts` (`requestServices`), never provided by a worker-level layer.
 */
export const PhoenixFateLive: Layer.Layer<
	WorkerFateServices | FateServer,
	never,
	Database | BetterAuth.BetterAuth | Flagship | RuntimeContext
> = FateServer.layer(fateConfig, [CurrentActor]).pipe(Layer.provideMerge(makeFateLayer));
