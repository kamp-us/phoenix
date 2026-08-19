/**
 * `AppLive` — the single router layer the worker's `fetch` is compiled from
 * (ADR 0027, `.patterns/alchemy-http-router.md`).
 *
 * The raw routes lift their handler's `R` into route-requirement markers that
 * plain `Layer.provide` does NOT discharge — they must be discharged with
 * `HttpRouter.provideRequest` (ADR 0029).
 */
import type * as BetterAuth from "@alchemy.run/better-auth";
import type {FateServer} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import type {WorkerFateServices} from "../features/fate/layers.ts";
import type {LiveConnections, LiveTopics} from "../features/fate-live/topics.ts";
import type {Flagship} from "../features/flagship/Flagship.ts";
import {healthApiLayer} from "./health.ts";
import {rawWorkerRouteLayers} from "./worker-routes.ts";

export const makeAppLive = (options: {
	/**
	 * Pinning `R = never` makes the dual-build state unrepresentable — raw
	 * `makeFateLayer` no longer typechecks here, so `provideRequest` can never
	 * silently construct a second Drizzle/Pasaport per request (ADRs 0041/0043).
	 */
	readonly fateLayer: Layer.Layer<WorkerFateServices | FateServer>;
	readonly liveLayer: Layer.Layer<LiveTopics | LiveConnections>;
	/**
	 * Must be the INIT-RESOLVED `Layer.succeed(...)(betterAuth)`, NOT `BetterAuthLive`:
	 * `provideRequest` builds its layer per request, and reconstructing better-auth
	 * needs deploy-time alchemy machinery that is absent in workerd.
	 */
	readonly betterAuthLayer: Layer.Layer<BetterAuth.BetterAuth>;
	readonly runtimeContext: BaseRuntimeContext;
	readonly flagshipLayer: Layer.Layer<Flagship>;
}) => {
	const typedJson = healthApiLayer.pipe(Layer.provide(options.flagshipLayer));

	// Do NOT add a second `Flags` build here (#1438): the raw flag routes resolve it
	// from `options.fateLayer`, the ONE build the fate resolvers read. A second
	// singleton would let the local flag-flip cookie diverge between the two
	// consumer sets.
	const rawRoutes = Layer.mergeAll(...rawWorkerRouteLayers).pipe(
		HttpRouter.provideRequest(
			Layer.mergeAll(
				options.fateLayer,
				options.liveLayer,
				options.betterAuthLayer,
				Layer.succeed(RuntimeContext)(options.runtimeContext),
			),
		),
	);

	return Layer.mergeAll(typedJson, rawRoutes);
};
