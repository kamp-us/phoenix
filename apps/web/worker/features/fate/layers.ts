/**
 * Worker-level fate layers. See ADR 0041/0043,
 * `.patterns/fate-effect-worker-wiring.md` and `.patterns/effect-layer-composition.md`.
 *
 * There is no runtime on the request path: the one isolate-level `ManagedRuntime`
 * is a layer-build vehicle only.
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import {CurrentActor} from "@kampus/authz";
import {FateServer} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type {Database} from "../../db/Database.ts";
import {DrizzleLive} from "../../db/Drizzle.ts";
import {NotificationLive} from "../bildirim/Notification.ts";
import {DivanLive} from "../divan/Divan.ts";
import {FlagsDevOverrideLive} from "../flagship/Flags.ts";
import {RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import type {Flagship} from "../flagship/Flagship.ts";
import {FunnelLive} from "../funnel/Funnel.ts";
import {AgentAuthorityV1} from "../kunye/AgentAuthorityV1.ts";
import {Kunye, KunyeLive} from "../kunye/Kunye.ts";
import {RelationStoreLive} from "../kunye/RelationStore.ts";
import {authorshipLadder} from "../kunye/standing.ts";
import {VouchLedgerLive} from "../kunye/VouchLedger.ts";
import {MecmuaLive} from "../mecmua/Mecmua.ts";
import {MuteLive} from "../mute/Mute.ts";
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
import {RateLimiterLive} from "../throttle/RateLimiter.ts";
import {InIsolateRateLimitStoreLive} from "../throttle/RateLimitStore.ts";
import {throttleMutations} from "../throttle/throttle-mutations.ts";
import {KarmaBump, VoteLive, VoterStanding} from "../vote/Vote.ts";
import {fateConfig} from "./config.ts";

export type WorkerFateServices = Layer.Success<typeof makeFateLayer>;

export type WorkerRuntime = ManagedRuntime.ManagedRuntime<WorkerFateServices | FateServer, never>;

/**
 * The shared `memoMap` keeps the runtime and its derived `contextLayer` on one
 * memoization scope, so worker singletons are built exactly once.
 *
 * Never disposed in the worker: a Cloudflare isolate has no shutdown hook, so
 * `runtime.dispose()` is never called and nothing pooled leaks (ADR 0041).
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
 * `pasaport-from-tag.test.ts` pins that the stub is never actually read; if it
 * starts failing, widen `R` — do not delete the test.
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

/** Vote owns the `KarmaBump` contract; the `vote/ → pasaport/` arrow lives only here. */
const KarmaBumpFromPasaport = Layer.succeed(KarmaBump, {statements: karmaBumpStatements});

/**
 * Vote owns the `VoterStanding` contract; the `vote/ → kunye/` arrow lives only here.
 *
 * `isAboveNewcomer` is `gte(tier, "yazar")` on purpose: the ladder is
 * `visitor < çaylak < yazar` (ADR 0107 §4), so a fresh çaylak — every
 * open-registration signup — is refused. Do not relax it to `gte(…, "çaylak")`.
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
 * The dev-override wrapper is installed unconditionally on purpose (#2741): it is
 * inert unless the per-request `FlagsContext.overrides` is populated, and THAT is
 * the gate (`overridesAuthorized` — dev, or an admin). Admin-ness is per-request,
 * so it cannot be selected at layer build.
 */
export const FateFlagsLive = FlagsDevOverrideLive;

/**
 * The worker-level data-plane layer (ADR 0029, ADR 0040).
 *
 * `Layer.provide` vs `provideMerge` is meaningful here: `provide` discharges a
 * layer's *internal* contract (Vote's `KarmaBump`/`VoterStanding`, Telemetry),
 * `provideMerge` keeps the service in {@link WorkerFateServices} for the routes.
 */
export const makeFateLayer = Layer.mergeAll(
	DivanLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(SozlukLive, PanoLive).pipe(
				Layer.provideMerge(VoteLive),
				Layer.provideMerge(BookmarkLive),
				Layer.provideMerge(ReactionLive),
				Layer.provide(TelemetryLive),
				Layer.provide(KarmaBumpFromPasaport),
				Layer.provide(VoterStandingFromKunye),
				// The repeat is deliberate: the same layer value memoizes to one isolate
				// instance via `makeFateRuntime`'s memoMap.
				Layer.provide(TelemetryLive),
			),
		),
	),
	StatsLive,
	TelemetryLive,
	SearchLive,
	ReportLive,
	FunnelLive,
	NotificationLive,
	MecmuaLive,
	MuteLive,
	RelationStoreLive,
	AgentAuthorityV1,
	KunyeLive,
	VouchLedgerLive,
	RateLimiterLive.pipe(Layer.provide(InIsolateRateLimitStoreLive)),
	FateFlagsLive,
).pipe(Layer.provideMerge(PasaportFromTag), Layer.provideMerge(DrizzleLive));

/**
 * The composed fate-server layer. See `.patterns/fate-effect-server.md`.
 *
 * The third argument registers the per-request services (ADR 0107 §7); they are
 * excluded from build-time R and fulfilled per request in `route.ts`.
 */
export const PhoenixFateLive: Layer.Layer<
	WorkerFateServices | FateServer,
	never,
	Database | BetterAuth.BetterAuth | Flagship | TelemetryClient | RuntimeContext
> = FateServer.layer(
	// Only the serving path is throttled; codegen (`schema.ts`) uses the plain `fateConfig`.
	{...fateConfig, mutations: throttleMutations(fateConfig.mutations)},
	[CurrentActor, RequestFlagOverrides, PanoFeedCache],
).pipe(Layer.provideMerge(makeFateLayer));
