/**
 * `GET /api/pipeline` — the structured pipeline-state endpoint (#252, ADR 0027).
 * A raw `HttpRouter.add` route (mirrors apps/web's per-feature `route.ts` files):
 * runs the `Pipeline` service, encodes the result against `PipelineState`'s
 * `effect/Schema` (the response-shape validation), and returns it as JSON.
 *
 * The handler's `Pipeline` requirement is lifted into a route-requirement marker
 * that `HttpRouter.provideRequest` discharges in `http/app.ts` (ADR 0029).
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {Pipeline} from "./Pipeline.ts";
import {encodePipelineState} from "./schema.ts";

const errorResponse = (status: number, message: string) =>
	HttpServerResponse.jsonUnsafe(
		{error: message},
		{status, headers: {"content-type": "application/json; charset=utf-8"}},
	);

export const handlePipeline = Effect.gen(function* () {
	const pipeline = yield* Pipeline;

	// A GitHub fetch failure becomes a 502 (the worker is a healthy proxy to an
	// upstream that failed), recovered via `Effect.result` so it never escapes the
	// handler. The Schema encode `orDie`s: a parse that doesn't satisfy the wire
	// schema is a worker bug, not a request-time condition.
	const result = yield* Effect.result(pipeline.getState);
	if (result._tag === "Failure") {
		const e = result.failure;
		return errorResponse(502, `GitHub fetch failed (${e.path}): ${e.message}`);
	}

	const body = yield* encodePipelineState(result.success).pipe(Effect.orDie);
	return HttpServerResponse.jsonUnsafe(body, {
		headers: {"content-type": "application/json; charset=utf-8"},
	});
});

export const pipelineRoute = HttpRouter.add("GET", "/api/pipeline", handlePipeline);
