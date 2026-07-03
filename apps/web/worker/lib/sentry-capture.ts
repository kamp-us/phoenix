/**
 * Explicit unhandled-failure capture at the Effect router seam (ADR 0118, #1502).
 *
 * Why here and not the `@sentry/effect` layer (`sentry-effect.ts`): that layer only
 * mirrors Effect spans to Sentry spans (Tracer) and routes `Effect.log*` to Sentry
 * logs/breadcrumbs (Logger) — it NEVER calls `captureException`, so it cannot turn an
 * unhandled defect into an issue. And alchemy's `makeRequestEffect` wraps the handler in
 * `Http.safeHttpEffect` (`Effect.catchCause`), whose error channel is `never` — it
 * consumes every failure/defect into a 499/500 Response before `wrapRequestHandler`'s
 * `captureErrors` can see it. So issue capture is wired HERE.
 *
 * Why CATCH-and-return, not tap-and-re-raise: verified against the live stage, a captured
 * event NEVER ships when the request's fiber ultimately DIES (→ 500) — even with an
 * awaited inline `flush` before the die — whereas a handler that SUCCEEDS ships reliably.
 * The transport buffers the send until `flush`, and a dying fiber's flushed send is lost.
 * So this seam catches the cause, captures + flushes INLINE (the proven path — the manual
 * `captureException` + `flush` that created the first live issue), and RETURNS the
 * response as a SUCCESS value: the fiber never dies past here, so the flush lands.
 *
 * Because it produces the response for caught causes, it mirrors `safeHttpEffect`'s OWN
 * mapping so the DSN-on and DSN-off (`baseFetch`) paths return identical responses:
 * a pure client abort (interrupt-only) → 499 and is NOT captured; everything else →
 * 500 and IS captured. That split is exactly the "capture defects + 5xx, skip the
 * expected 4xx/499" policy of ADR 0118: at this seam `safeHttpEffect` collapses every
 * non-interrupt failure to a 500, so non-interrupt == 5xx == capture-worthy, and the
 * only 4xx-class thing here is the 499 client abort (SSE disconnects), which is skipped.
 * Only the 5xx path pays the inline-flush latency, and 5xx are rare.
 */
import {captureException, flush} from "@sentry/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The pure gate (unit-tested): a real (non-interrupt) failure worth capturing. Mirrors
 * `safeHttpEffect`'s 499-vs-500 split — a pure client abort (interrupt-only) is expected
 * and skipped; any cause carrying a `Fail` or `Die` is a 5xx crash and captured.
 */
export function shouldCaptureCause(cause: Cause.Cause<unknown>): boolean {
	return cause.reasons.length > 0 && !Cause.hasInterruptsOnly(cause);
}

/**
 * Wrap the router handler so an unhandled 5xx-class `Cause` reaches Sentry as an issue,
 * returning the same response `safeHttpEffect` would (499 for a client abort, else 500)
 * as a SUCCESS value so the flush can land before the fiber unwinds.
 *
 * The capture, flush, AND response all happen inside ONE `Effect.promise`: verified on
 * the live stage that chaining any effect AFTER the flush (even an `Effect.logError`)
 * loses the event, while returning the response from within the same awaited promise
 * ships it reliably. So the server-side "handler failed" log rides on `console.error`
 * here (Workers Observability captures it) rather than a trailing `Effect.logError`.
 */
export function captureUnhandled<E, R>(
	handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> {
	return Effect.catchCause(handler, (cause) => {
		if (!shouldCaptureCause(cause)) {
			return Effect.succeed(HttpServerResponse.empty({status: 499}));
		}
		return Effect.promise(async () => {
			console.error("HTTP handler failed", Cause.pretty(cause));
			for (const error of Cause.prettyErrors(cause)) {
				captureException(error);
			}
			await flush(2000);
			return HttpServerResponse.text("Internal Server Error", {
				status: 500,
				statusText: "Internal Server Error",
			});
		});
	});
}
