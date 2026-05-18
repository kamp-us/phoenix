import {Layer, ManagedRuntime} from "effect";
import type {Session} from "../features/pasaport/auth";
import {Auth, CloudflareEnv, type Drizzle, DrizzleLive, RequestContext} from "../services";

/**
 * Per-request GraphQL runtime composition.
 *
 * Layers, bottom-up:
 *   CloudflareEnv + RequestContext + Auth     (per-request values)
 *     ↑
 *   Drizzle                                    (single builder over PHOENIX_DB)
 *     ↑
 *   FeatureLayer (Sozluk, Pano, Vote, …)       (filled by tasks 2–5)
 *
 * Tasks 2–5 of the effect-migration each port a feature `module.ts` to a
 * `Context.Service` and merge its `Live` layer into `FeatureLayer`. Until they
 * do, `FeatureLayer` is `Layer.empty` so the composed runtime is `R = never`
 * and resolvers that haven't been flipped keep using the legacy async
 * `module.ts` functions off `env`.
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
	export type Context = CloudflareEnv | RequestContext | Auth | Drizzle;

	/**
	 * Placeholder for the per-feature service merge — populated incrementally
	 * by tasks 2–5. `Layer.empty` provides nothing and requires nothing, so
	 * `Layer.mergeAll(FeatureLayer, ...)` is well-typed today.
	 *
	 * When a feature lands, replace the body with `Layer.mergeAll(SozlukLive, …)`
	 * and widen the second type param if any of those layers carries deps the
	 * outer composition doesn't already provide.
	 */
	const FeatureLayer: Layer.Layer<never> = Layer.empty;

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

		// Bottom-up: RequestValues satisfies Drizzle's needs; the merged feature
		// + drizzle layer is then provided with RequestValues. The outer merge
		// re-exposes RequestValues so resolvers can `yield* Auth` / `yield*
		// CloudflareEnv` directly.
		const DataPlane = Layer.mergeAll(FeatureLayer, DrizzleLive).pipe(Layer.provide(RequestValues));

		return Layer.mergeAll(DataPlane, RequestValues);
	};

	export const make = (
		env: Env,
		request: Request,
		sessionData: SessionData,
	): ManagedRuntime.ManagedRuntime<Context, never> =>
		ManagedRuntime.make(layer(env, request, sessionData));
}
