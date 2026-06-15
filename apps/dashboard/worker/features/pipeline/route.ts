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
import {encodePipelineResponse} from "./schema.ts";

const errorResponse = (status: number, message: string) =>
	HttpServerResponse.jsonUnsafe(
		{error: message},
		{status, headers: {"content-type": "application/json; charset=utf-8"}},
	);

export const handlePipeline = Effect.gen(function* () {
	const pipeline = yield* Pipeline;

	// A GitHub fetch failure with a warm cache is served as the last good snapshot
	// flagged `stale` (#254) — it never reaches here. A 502 is left for the
	// cold-cache case alone: GitHub failed AND there's no prior snapshot to fall
	// back to. Recovered via `Effect.result` so it never escapes the handler. The
	// Schema encode `orDie`s: a response that doesn't satisfy the wire schema is a
	// worker bug, not a request-time condition.
	const result = yield* Effect.result(pipeline.getState);
	if (result._tag === "Failure") {
		const e = result.failure;
		// GitHub's response body (#292) rides along when present, so a 403's reason
		// ("Resource not accessible…" vs a rate-limit) is readable from the error.
		const reason = e.detail ? `${e.message} — ${e.detail}` : e.message;
		return errorResponse(502, `GitHub fetch failed (${e.path}): ${reason}`);
	}

	const body = yield* encodePipelineResponse(result.success).pipe(Effect.orDie);
	return HttpServerResponse.jsonUnsafe(body, {
		headers: {"content-type": "application/json; charset=utf-8"},
	});
});

export const pipelineRoute = HttpRouter.add("GET", "/api/pipeline", handlePipeline);
