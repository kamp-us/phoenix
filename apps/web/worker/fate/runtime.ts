import {Effect, Layer, ManagedRuntime} from "effect";
import {type Pano, PanoLive} from "../features/pano/Pano";
import type {Session} from "../features/pasaport/auth";
import {Pasaport, PasaportLive} from "../features/pasaport/Pasaport";
import {type Sozluk, SozlukLive} from "../features/sozluk/Sozluk";
import {type Stats, StatsLive} from "../features/stats/Stats";
import {type Vote, VoteLive} from "../features/vote/Vote";
import {Auth, CloudflareEnv, type Drizzle, DrizzleLive, RequestContext} from "../services";

/**
 * Per-request fate runtime composition.
 *
 * The Hono `/fate` route owns one
 * `ManagedRuntime` per request: it validates the session, builds the runtime
 * with that session baked into the `Auth` layer, hands it to fate via
 * `adapterContext`, and disposes it in `finally` via `executionCtx.waitUntil`
 * (ADR 0017). The bridge helpers (`fateQuery`/`fateList`/`fateMutation`/
 * `fateSource`) run resolver/source generators through it.
 *
 * Layers, bottom-up:
 *   CloudflareEnv + RequestContext + Auth     (per-request values)
 *     ↑
 *   Drizzle                                    (single builder over PHOENIX_DB)
 *     ↑
 *   FeatureLayer (Sozluk, Pano, Vote, Pasaport, Stats)
 *
 * `SozlukLive` and `PanoLive` both depend on `Vote`; we chain
 * `provideMerge(VoteLive)` once and merge both into a single sub-layer so the
 * parallel-merge check stays satisfied. `PasaportLive` and `StatsLive` depend
 * only on `Drizzle`, so they merge in directly.
 *
 * See `.patterns/fate-server-wiring.md`, `.patterns/effect-layer-composition.md`,
 * and ADR 0010/0017 for the design.
 */

export type SessionData = {
	user?: Session["user"];
	session?: Session["session"];
} | null;

export namespace FateRuntime {
	/**
	 * Services available inside a fate resolver / source executor Effect.
	 */
	export type Context =
		| CloudflareEnv
		| RequestContext
		| Auth
		| Drizzle
		| Pasaport
		| Vote
		| Sozluk
		| Pano
		| Stats;

	/**
	 * Merge of every per-feature service that resolvers/executors `yield*`.
	 * `SozlukLive` and `PanoLive` both depend on `Vote`; we merge them first
	 * (parallel — neither depends on the other) and `provideMerge(VoteLive)`
	 * once. The resulting sub-layer exposes `Vote | Sozluk | Pano`; the outer
	 * `Layer.mergeAll` adds `PasaportLive` and `StatsLive` (both depend only on
	 * `Drizzle`).
	 */
	const SozlukPanoLayer = Layer.mergeAll(SozlukLive, PanoLive).pipe(Layer.provideMerge(VoteLive));
	const FeatureLayer = Layer.mergeAll(PasaportLive, SozlukPanoLayer, StatsLive);

	export const layer = (
		env: Env,
		request: Request,
		sessionData: SessionData,
	): Layer.Layer<Context, never, never> => {
		const RequestValues = Layer.mergeAll(
			Layer.succeed(CloudflareEnv, env),
			Layer.succeed(RequestContext, {
				headers: request.headers,
				url: request.url,
				method: request.method,
			}),
			Layer.succeed(Auth, {
				user: sessionData?.user,
				session: sessionData?.session,
			}),
		);

		const Features = FeatureLayer.pipe(Layer.provide(DrizzleLive));
		const DataPlane = Layer.mergeAll(Features, DrizzleLive).pipe(Layer.provide(RequestValues));

		return Layer.mergeAll(DataPlane, RequestValues);
	};

	export const make = (
		env: Env,
		request: Request,
		sessionData: SessionData,
	): ManagedRuntime.ManagedRuntime<Context, never> =>
		ManagedRuntime.make(layer(env, request, sessionData));
}

/**
 * Validate the better-auth session cookie on a request.
 *
 * Both `/fate` and `/fate/live` need the session resolved *before* the data
 * plane is wired: `/fate` bakes it into the request runtime's `Auth` layer,
 * `/fate/live` uses it to authorize the SSE connection. The cookie check only
 * touches `Pasaport.validateSession` (which reads `env.PHOENIX_DB` via
 * better-auth), so this runs through a minimal Pasaport-only runtime —
 * `PasaportLive` over `Drizzle` + `CloudflareEnv` — instead of a full
 * `FateRuntime` (all five features + every layer). The short-lived runtime is
 * disposed before the caller hands off to the data plane, so `/fate` builds
 * exactly one full `FateRuntime` per request, not two.
 */
export const validateSessionCookie = async (
	env: Env,
	request: Request,
): Promise<Session | null> => {
	const layer = PasaportLive.pipe(
		Layer.provide(DrizzleLive),
		Layer.provide(Layer.succeed(CloudflareEnv, env)),
	);
	const runtime = ManagedRuntime.make(layer);
	try {
		return await runtime.runPromise(
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.validateSession(request.headers);
			}),
		);
	} finally {
		await runtime.dispose();
	}
};

/** Build the `Auth`-layer `SessionData` from a resolved session (or null). */
export const toSessionData = (session: Session | null): SessionData =>
	session ? {user: session.user, session: session.session} : null;
