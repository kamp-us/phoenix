import {Layer, ManagedRuntime} from "effect";
import {type AdminAuth, AdminAuthLive, CloudflareEnv, type Drizzle, DrizzleLive} from "../services";

/**
 * Per-request admin runtime composition.
 *
 * Layers, bottom-up:
 *   CloudflareEnv                              (per-request value)
 *     ↑
 *   Drizzle + AdminAuth                        (env-derived capabilities)
 *     ↑
 *   AdminFeatureLayer (SozlukAdmin, …)         (filled by tasks 2–5)
 *
 * Separate from the GraphQL runtime per ADR 0012: admin operations need
 * `AdminAuth.required` (env-gated initially; future hardening lands inside the
 * layer with no call-site changes), don't need GraphQL `Auth`, and run a
 * disjoint set of services that shouldn't pollute the resolver context.
 *
 * Until each feature ports its `<Feature>Admin` service in tasks 2–5,
 * `AdminFeatureLayer` is `Layer.empty` — the Hono admin routes keep using
 * legacy module functions and the runtime composes to `R = never`.
 */

export namespace AdminRuntime {
	/**
	 * Services available inside an admin Effect. Expands as `SozlukAdmin`,
	 * `PanoAdmin`, `PasaportAdmin` land.
	 */
	export type Context = CloudflareEnv | Drizzle | AdminAuth;

	/**
	 * Placeholder for the per-feature admin-service merge. Filled by tasks
	 * 2–5; `Layer.empty` keeps the composition well-typed in the meantime.
	 */
	const AdminFeatureLayer: Layer.Layer<never> = Layer.empty;

	export const layer = (env: Env): Layer.Layer<Context, never, never> => {
		const RequestValues = Layer.succeed(CloudflareEnv, env);
		const Capabilities = Layer.mergeAll(DrizzleLive, AdminAuthLive).pipe(
			Layer.provide(RequestValues),
		);
		const DataPlane = Layer.mergeAll(AdminFeatureLayer, Capabilities);

		return Layer.mergeAll(DataPlane, RequestValues);
	};

	export const make = (env: Env): ManagedRuntime.ManagedRuntime<Context, never> =>
		ManagedRuntime.make(layer(env));
}
