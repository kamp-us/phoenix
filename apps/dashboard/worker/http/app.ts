/**
 * `AppLive` — the single router layer the worker's `fetch` is compiled from
 * (ADR 0027, `.patterns/worker-http-transport-layout.md`). Assembles two kinds of
 * route: the typed-JSON `health` group (`GET /api/health`) and the raw-`Request`
 * `pipeline` route (`GET /api/pipeline`).
 *
 * The raw route lifts its handler's `R` (`Pipeline`) into a route-requirement
 * marker that plain `Layer.provide` does NOT discharge — it is discharged with
 * `HttpRouter.provideRequest` (ADR 0029), mirroring apps/web's `makeAppLive`.
 */
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import type {Pipeline} from "../features/pipeline/Pipeline.ts";
import {pipelineRoute} from "../features/pipeline/route.ts";
import {healthApiLayer} from "./health.ts";

/**
 * Build the application router layer.
 *
 * @param options.pipelineLayer the `Pipeline` service as a DEPENDENCY-FREE context
 *   layer (`R = never`) — resolved once in init (`index.ts`) so `provideRequest`
 *   doesn't reconstruct the GitHub client per request. Tests pass a stub over the
 *   same tag; both thread through `provideRequest` identically.
 */
export const makeAppLive = (options: {readonly pipelineLayer: Layer.Layer<Pipeline>}) => {
	const typedJson = healthApiLayer;

	const rawRoutes = pipelineRoute.pipe(HttpRouter.provideRequest(options.pipelineLayer));

	return Layer.mergeAll(typedJson, rawRoutes);
};
