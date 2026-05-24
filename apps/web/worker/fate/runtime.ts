import {Layer, ManagedRuntime} from "effect";
import {type Pano, PanoLive} from "../features/pano/Pano";
import type {Session} from "../features/pasaport/auth";
import {type Pasaport, PasaportLive} from "../features/pasaport/Pasaport";
import {type Sozluk, SozlukLive} from "../features/sozluk/Sozluk";
import {type Stats, StatsLive} from "../features/stats/Stats";
import {type Vote, VoteLive} from "../features/vote/Vote";
import {Auth, CloudflareEnv, type Drizzle, DrizzleLive, RequestContext} from "../services";

/**
 * Per-request fate runtime composition.
 *
 * This is the same layer graph the GraphQL handler built (`GraphQLRuntime`),
 * renamed for its new owner — fate. The Hono `/fate` route owns one
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
