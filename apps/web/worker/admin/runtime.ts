import {Layer, ManagedRuntime} from "effect";
import {type PanoAdmin, PanoAdminLive} from "../features/pano/PanoAdmin.ts";
import {type PasaportAdmin, PasaportAdminLive} from "../features/pasaport/PasaportAdmin.ts";
import {type SozlukAdmin, SozlukAdminLive} from "../features/sozluk/SozlukAdmin.ts";
import {
	type AdminAuth,
	AdminAuthLive,
	CloudflareEnv,
	type Drizzle,
	DrizzleLive,
} from "../services/index.ts";
import type {WorkerEnv} from "../shared/worker-env.ts";

/**
 * Per-request admin runtime composition.
 *
 * Layers, bottom-up:
 *   CloudflareEnv                              (per-request value)
 *     ↑
 *   Drizzle + AdminAuth                        (env-derived capabilities)
 *     ↑
 *   AdminFeatureLayer (PasaportAdmin, …)       (filled by tasks 2–5)
 *
 * Separate from the fate request runtime per ADR 0012: admin operations need
 * `AdminAuth.required` (env-gated initially; future hardening lands inside the
 * layer with no call-site changes), don't need the session-derived `Auth`, and
 * run a disjoint set of services that shouldn't pollute the resolver context.
 *
 * Pasaport's admin slice (`PasaportAdminLive`) landed in task 2. Sozluk + Pano
 * admin services are still pending — `AdminFeatureLayer` grows as they arrive.
 */

export namespace AdminRuntime {
	/**
	 * Services available inside an admin Effect. Expands as `SozlukAdmin`,
	 * `PanoAdmin` land.
	 */
	export type Context =
		| CloudflareEnv
		| Drizzle
		| AdminAuth
		| PasaportAdmin
		| SozlukAdmin
		| PanoAdmin;

	/**
	 * Merge of every per-feature admin service. Each `Live` layer depends on
	 * `Drizzle + CloudflareEnv`, satisfied by `Capabilities`.
	 */
	const AdminFeatureLayer = Layer.mergeAll(PasaportAdminLive, SozlukAdminLive, PanoAdminLive);

	export const layer = (env: WorkerEnv): Layer.Layer<Context, never, never> => {
		const RequestValues = Layer.succeed(CloudflareEnv, env);
		const Features = AdminFeatureLayer.pipe(Layer.provide(DrizzleLive));
		const Capabilities = Layer.mergeAll(DrizzleLive, AdminAuthLive).pipe(
			Layer.provide(RequestValues),
		);
		const DataPlane = Layer.mergeAll(Features, Capabilities).pipe(Layer.provide(RequestValues));

		return Layer.mergeAll(DataPlane, RequestValues);
	};

	export const make = (env: WorkerEnv): ManagedRuntime.ManagedRuntime<Context, never> =>
		ManagedRuntime.make(layer(env));
}
