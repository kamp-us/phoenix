import {Layer, ManagedRuntime} from "effect";
import type {Session} from "../features/pasaport/auth";
import {type Pasaport, PasaportLive} from "../features/pasaport/Pasaport";
import {Auth, CloudflareEnv, type Drizzle, DrizzleLive, RequestContext} from "../services";

/**
 * Per-request GraphQL runtime composition.
 *
 * Layers, bottom-up:
 *   CloudflareEnv + RequestContext + Auth     (per-request values)
 *     ↑
 *   Drizzle                                    (single builder over PHOENIX_DB)
 *     ↑
 *   FeatureLayer (Sozluk, Pano, Vote, Pasaport) (filled by tasks 2–5)
 *
 * Tasks 2–5 of the effect-migration each port a feature `module.ts` to a
 * `Context.Service` and merge its `Live` layer into `FeatureLayer`. Pasaport
 * landed in task 2 (`PasaportLive`); the rest are still pending.
 *
 * See `.patterns/effect-layer-composition.md` and ADR 0010 for the design.
 */

export type SessionData = {
	user?: Session["user"];
	session?: Session["session"];
} | null;

export namespace GraphQLRuntime {
	/**
	 * Services available inside a GraphQL resolver Effect. As feature services
	 * land they get added to this union so resolvers can `yield*` them.
	 */
	export type Context = CloudflareEnv | RequestContext | Auth | Drizzle | Pasaport;

	/**
	 * Merge of every per-feature service that resolvers `yield*`. Each `Live`
	 * layer depends on `Drizzle + CloudflareEnv`, satisfied by the outer
	 * composition via `Layer.provide(RequestValues)` below.
	 */
	const FeatureLayer = Layer.mergeAll(PasaportLive);

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

		// Bottom-up: RequestValues satisfies Drizzle's needs; DrizzleLive
		// satisfies the feature services' Drizzle dep; RequestValues at the
		// top re-exposes per-request values for resolvers to `yield*` directly.
		// The sequential `Layer.provide` calls keep
		// `@effect/language-service`'s `layerMergeAllWithDependencies` check
		// happy by never merging a layer in parallel with one that depends on
		// it.
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
