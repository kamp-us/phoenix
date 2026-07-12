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
import {CurrentActor} from "@kampus/authz";
import {FateServer} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import {AppConfig} from "../../config.ts";
import type {Database} from "../../db/Database.ts";
import {DrizzleLive} from "../../db/Drizzle.ts";
import {NotificationLive} from "../bildirim/Notification.ts";
import {DivanLive} from "../divan/Divan.ts";
import {FlagsDevOverrideLive, FlagsLive} from "../flagship/Flags.ts";
import {RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import type {Flagship} from "../flagship/Flagship.ts";
import {FunnelLive} from "../funnel/Funnel.ts";
import {AgentAuthorityV1} from "../kunye/AgentAuthorityV1.ts";
import {Kunye, KunyeLive} from "../kunye/Kunye.ts";
import {RelationStoreLive} from "../kunye/RelationStore.ts";
import {authorshipLadder} from "../kunye/standing.ts";
import {VouchLedgerLive} from "../kunye/VouchLedger.ts";
import {MecmuaLive} from "../mecmua/Mecmua.ts";
import {BookmarkLive} from "../pano/Bookmark.ts";
import {PanoFeedCache} from "../pano/feed-cache.ts";
import {PanoLive} from "../pano/Pano.ts";
import {karmaBumpStatements} from "../pasaport/karma.ts";
import {makePasaportLive} from "../pasaport/Pasaport.ts";
import {ReactionLive} from "../reaction/Reaction.ts";
import {ReportLive} from "../report/Report.ts";
import {SearchLive} from "../search/Search.ts";
import {SozlukLive} from "../sozluk/Sozluk.ts";
import {StatsLive} from "../stats/Stats.ts";
import {type TelemetryClient, TelemetryLive} from "../telemetry/Telemetry.ts";
import {KarmaBump, VoteLive, VoterStanding} from "../vote/Vote.ts";
import {fateConfig} from "./config.ts";

/**
 * The worker's fate service list — DERIVED from {@link makeFateLayer}'s
 * `Layer.mergeAll(...)` success channel so the list is declared exactly ONCE (the
 * runtime composition is the single source of truth; #1340). Adding/removing a
 * feature service is now one edit — its `*Live` in `makeFateLayer` — not a union
 * member kept in lockstep with the composition by eye.
 *
 * The per-service rationale (which ADR/issue each service answers to) lives at its
 * `*Live` entry in `makeFateLayer`'s body. `CurrentActor` is deliberately absent
 * from this set: it is per-request, registered separately on {@link PhoenixFateLive}
 * (`[CurrentActor]`, ADR 0107 §7), so it never enters the build-time success channel.
 */
export type WorkerFateServices = Layer.Success<typeof makeFateLayer>;

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
const KarmaBumpFromPasaport = Layer.succeed(KarmaBump, {statements: karmaBumpStatements});

/**
 * Künye's implementation of the `VoterStanding` contract Vote owns (dependency
 * inversion — the `vote/ → kunye/` arrow lives ONLY at this seam, #1810). The
 * predicate is the "earn to vote" floor: the voter must be **above the çaylak
 * newcomer tier** on the `authorshipLadder` (`visitor < çaylak < yazar`, ADR 0107
 * §4). `authorshipLadder.gte(tier, "yazar")` is `true` only for a promoted `yazar`
 * (or any future higher rank), so a fresh `çaylak` — every open-registration signup —
 * and a `visitor` are both refused. Keeping the tier comparison here (not in Vote)
 * is what lets the ladder move without touching Vote.
 */
const VoterStandingFromKunye = Layer.effect(VoterStanding)(
	Effect.gen(function* () {
		const kunye = yield* Kunye;
		return {
			isAboveNewcomer: (voterId: string) =>
				Effect.map(kunye.tierOf(voterId), (tier) => authorshipLadder.gte(tier, "yazar")),
		};
	}),
).pipe(Layer.provide(KunyeLive));

/**
 * The `Flags` layer for the fate data plane, environment-selected at layer build —
 * the fate-runtime twin of the raw-route selection in `http/app.ts` (the #622 gate).
 * Under `development` it installs the dev-override wrapper (`FlagsDevOverrideLive`) so
 * a flag-gated fate resolver/mutation honors the `phoenix_flag_overrides` cookie that
 * `provideRequestFlags` threads off `RequestFlagOverrides`; every other stage
 * (including the `production` fail-closed default of `AppConfig.environment`,
 * `config.ts`) builds the plain `FlagsLive`, so the override branch is structurally
 * absent from every deployed stage's fate flag path — the same fail-closed gate as
 * the raw routes, applied at the one place the fate runtime resolves `Flags` (#1868:
 * without this, `makeFateLayer` baked `FlagsLive` unconditionally, so the dev-override
 * decorator was never on the fate mutation path and the integration flag-flip cookie
 * had no effect). `AppConfig` reads off the ConfigProvider alchemy auto-wires at
 * worker scope — the same read `makeRequestFlagsContext` uses; both selector arms need
 * only `Flagship`, discharged at the composition root like `FlagsLive` was.
 */
export const FateFlagsLive = Layer.unwrap(
	Effect.gen(function* () {
		const {environment} = yield* AppConfig.pipe(Effect.orDie);
		return environment === "development" ? FlagsDevOverrideLive : FlagsLive;
	}),
);

/**
 * The worker-level data-plane layer (ADR 0029, ADR 0040). Derives everything from
 * the two seams in its `R` channel — `Database` (behind `DrizzleLive`) and
 * `BetterAuth` — so features and auth provably share one handle.
 *
 * `SozlukLive` and `PanoLive` both depend on `Vote`, so they merge first and
 * `provideMerge(VoteLive)` once — with Vote's two internal seams, `KarmaBump` and
 * `VoterStanding`, discharged by {@link KarmaBumpFromPasaport} and
 * {@link VoterStandingFromKunye} via `Layer.provide` (not `provideMerge`: these are
 * Vote's internal contracts, not worker services the routes see).
 *
 * `PanoLive` also depends on `Bookmark` (it stamps the `isSaved` viewer scalar
 * from `Bookmark.readMine` alongside `myVote`), so `BookmarkLive` joins the same
 * group via `provideMerge` — discharging Pano's requirement while keeping
 * `Bookmark` in {@link WorkerFateServices} for the routes that resolve it directly.
 */
export const makeFateLayer = Layer.mergeAll(
	// `DivanLive` composes the Sözlük + pano sandboxed reads (#1287), so it is provided
	// THIS content group's `Sozluk`/`Pano` outputs via `provideMerge` (which keeps them
	// in the output for the routes too) — one built instance, not a second copy.
	DivanLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(SozlukLive, PanoLive).pipe(
				Layer.provideMerge(VoteLive),
				Layer.provideMerge(BookmarkLive),
				// Both `SozlukLive` and `PanoLive` stamp the reaction aggregate on their
				// definition/post/comment reads (`Reaction.readAggregate`, #1862), so
				// `ReactionLive` joins the same group via `provideMerge` — discharging that
				// requirement while keeping `Reaction` in `WorkerFateServices` for the
				// wiring children (#1863/#1864/#1865) that resolve it directly.
				Layer.provideMerge(ReactionLive),
				// `Reaction.react` emits a product-usage event on a committed reaction
				// (the reference instrument #2, ADR 0153 / #2069), so `ReactionLive` now
				// requires `Telemetry`. Discharge it here with `Layer.provide` (like
				// Vote's internal seams — Telemetry is a dependency of the nested reaction
				// layer, not a routed service the content group re-exports; the top-level
				// `TelemetryLive` below keeps `Telemetry` in `WorkerFateServices`). Its
				// `TelemetryClient`/`RuntimeContext` requirements bubble to the root, where
				// they are init-provided on `PhoenixFateLive`.
				Layer.provide(TelemetryLive),
				Layer.provide(KarmaBumpFromPasaport),
				// Vote's voter-tier gate ("earn to vote", #1810), discharged by Künye — same
				// internal-seam idiom as `KarmaBumpFromPasaport` (`Layer.provide`, not a routed
				// service). Its `Pasaport` requirement bubbles to the root `PasaportFromTag`.
				Layer.provide(VoterStandingFromKunye),
				// Vote's telemetry instrument (ADR 0153, epic #2065, #2068): `Vote.cast` emits a
				// `vote` event after a committed cast, so `VoteLive` gains a build-time `Telemetry`
				// requirement. Discharged HERE with the SAME `TelemetryLive` merged flat below — the
				// shared layer value memoizes to one isolate instance via `makeFateRuntime`'s memoMap,
				// so `Telemetry` stays a worker output for future instruments (#2069) while Vote's
				// requirement is satisfied in-group; `TelemetryClient`/`RuntimeContext` bubble to the
				// same root that discharges the flat `TelemetryLive`.
				Layer.provide(TelemetryLive),
			),
		),
	),
	StatsLive,
	// The product-usage telemetry seam (ADR 0153, epic #2065) — the isolate-level
	// `Telemetry` service every instrument (#2068/#2069) emits through. Merges flat
	// like `Stats`: it resolves the init-provided `TelemetryClient` (the AE write
	// client, resolved once where the binding graph is ambient — like `Database`'s
	// D1 handle) and captures `RuntimeContext` at build (already an R seam here);
	// `emit` itself carries no R (both channels discharged in `TelemetryLive`).
	TelemetryLive,
	// SearchLive and ReportLive depend only on Drizzle (the FTS read / the report
	// write), so they merge flat alongside the other domain layers and are
	// discharged by `provideMerge(DrizzleLive)`.
	SearchLive,
	ReportLive,
	// The conversion-funnel read model (#1589) — a humans-only tier-population count
	// over the `user` table, depending only on `Drizzle` (discharged below), so it
	// merges flat like `Stats`/`Search`/`Report`.
	FunnelLive,
	// The bildirim spine's notification store + recipient-scoped read model (#1694,
	// epic #1666), depending only on `Drizzle` (discharged below) — merges flat.
	NotificationLive,
	// The mecmua long-form write service (#2497, epic #2467) — the publish + save-draft
	// acts, depending only on `Drizzle` (discharged below), so it merges flat like the
	// other domain layers. The publish yazar-floor is discharged at the mutation via
	// `PublishMecmua` (CurrentActor/AgentAuthority/Kunye already in this graph), not here.
	MecmuaLive,
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
	// The authorship-vouch ledger (#1206) — the `user.vouch` recorded-act store.
	// Reads/writes the `authorship_vouch` table off the same `Drizzle` seam below.
	VouchLedgerLive,
	// `Flags` is the dark-ship read surface fate resolvers/mutations gate on (#746,
	// #1868). Environment-selected by {@link FateFlagsLive}: the dev-override wrapper
	// under `development` (so the #622 override cookie is honored on the fate mutation
	// path), the plain `FlagsLive` on every deployed stage. Needs only `Flagship` (a new
	// R seam, discharged at the composition root like `Database`); `getBoolean`'s
	// `RuntimeContext`/`FlagsContext` are per-call, supplied by the resolver, not at
	// layer build.
	FateFlagsLive,
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
 * `[CurrentActor, RequestFlagOverrides, PanoFeedCache]` registers the per-request
 * services (ADR 0107 §7): the authz actor, the raw `Cookie` header the dev-override
 * flag path reads (#622), and the base-feed edge-cache purger a fanned pano mutation
 * fires alongside its live publish (ADR 0170 / #2324). All are excluded from build-time
 * R and fulfilled per request from the session/request/execution-context in `route.ts`
 * (`requestServices`), never provided by a worker-level layer.
 */
export const PhoenixFateLive: Layer.Layer<
	WorkerFateServices | FateServer,
	never,
	Database | BetterAuth.BetterAuth | Flagship | TelemetryClient | RuntimeContext
> = FateServer.layer(fateConfig, [CurrentActor, RequestFlagOverrides, PanoFeedCache]).pipe(
	Layer.provideMerge(makeFateLayer),
);
