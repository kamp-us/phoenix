/**
 * Explicit unhandled-failure capture at the Effect router seam (ADR 0118, #1502).
 *
 * Why here and not the `@sentry/effect` layer: that layer never calls
 * `captureException`, and alchemy's `safeHttpEffect` consumes every failure into a
 * 499/500 Response before `wrapRequestHandler`'s `captureErrors` can see it.
 *
 * Why CATCH-and-return rather than tap-and-re-raise: verified against the live stage,
 * a captured event NEVER ships when the request's fiber ultimately DIES — even with an
 * awaited inline `flush` — because the transport buffers the send and a dying fiber's
 * flushed send is lost. So this seam captures + flushes INLINE and returns the response
 * as a SUCCESS value; the fiber never dies past here, so the flush lands.
 *
 * Producing the response means mirroring `safeHttpEffect`'s own mapping, so DSN-on and
 * DSN-off paths return identical responses: a pure client abort (interrupt-only) → 499,
 * not captured; everything else → 500 and captured. Only the rare 5xx path pays the
 * inline-flush latency.
 */
import {captureException, flush} from "@sentry/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Dies rather than failing, keeping this seam's `E` channel `never` as callers require.
class SentryCaptureError extends Schema.TaggedErrorClass<SentryCaptureError>()(
	"web/SentryCaptureError",
	{cause: Schema.Defect()},
) {}

// Mirrors `safeHttpEffect`'s 499-vs-500 split: an interrupt-only cause is an expected
// client abort and skipped; a `Fail` or `Die` is a 5xx crash and captured.
export function shouldCaptureCause(cause: Cause.Cause<unknown>): boolean {
	return cause.reasons.length > 0 && !Cause.hasInterruptsOnly(cause);
}

/**
 * The capture, flush, AND response must stay inside ONE `Effect.promise`: verified on
 * the live stage, chaining any effect after the flush — even an `Effect.logError` —
 * loses the event. Hence `console.error` here rather than a trailing `Effect.logError`.
 */
export function captureUnhandled<E, R>(
	handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> {
	return Effect.catchCause(handler, (cause) => {
		if (!shouldCaptureCause(cause)) {
			return Effect.succeed(HttpServerResponse.empty({status: 499}));
		}
		return Effect.tryPromise({
			try: async () => {
				console.error("HTTP handler failed", Cause.pretty(cause));
				for (const error of Cause.prettyErrors(cause)) {
					captureException(error);
				}
				await flush(2000);
				return HttpServerResponse.text("Internal Server Error", {
					status: 500,
					statusText: "Internal Server Error",
				});
			},
			catch: (flushCause) => new SentryCaptureError({cause: flushCause}),
		}).pipe(Effect.orDie);
	});
}
