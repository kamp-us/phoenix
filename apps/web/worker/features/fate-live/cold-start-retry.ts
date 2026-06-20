/**
 * Cold-start resilience for the cross-DO `LiveDO` RPC seam (#842).
 *
 * Cloudflare evicts idle Durable Objects, so the FIRST `/fate/live` connect or
 * subscribe for an idle user hits a cold `connection:`/`topic:` DO. The alchemy
 * RPC stub (`makeRpcStub`) wraps every cross-DO call in
 * `Effect.tryPromise({catch: … RpcCallError})`, so a sub-second cold-start
 * transport failure surfaces as an `RpcCallError` in the call's FAILURE channel.
 *
 * THE TYPE LIE this module exists to handle: the `LiveDO` RPC surface declares
 * each method `Effect<…, never, never>` (`live-do.ts` `LiveRpcSurface`), but that
 * `never` is the *declared* shape, not the *runtime* one — `makeRpcStub` injects
 * `RpcCallError` into the failure channel that the static type erases. So this is
 * the one seam (the `index.ts` `liveLayer` call sites) where the transport error
 * is actually present at runtime and must be reinterpreted to be caught.
 *
 * The fix: a BOUNDED retry keyed ON THE TRANSPORT CHANNEL ONLY — capped
 * exponential backoff absorbs the warm window; a genuine app error (a typed DO
 * failure that is NOT `RpcCallError`) fails fast and passes through untouched. On
 * exhaustion the surviving transport failure becomes a typed
 * {@link LiveTransportError}, which the route renders as a graceful 503 envelope
 * instead of a defect-500.
 *
 * Schedule shape grounds in effect-smol `LLMS.md` §"Working with Schedules"
 * (`ai-docs/src/06_schedule/10_schedules.ts`): `retryBackoffWithLimit` =
 * `Schedule.both(exponential, recurs(N))` for capped backoff, and the
 * `retryableOnly` pattern (`Schedule.while` / `Retry.Options.while`) to retry only
 * the transport-error channel.
 */
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/**
 * A cross-DO call kept failing on the transport channel after the bounded
 * cold-start retry was exhausted. The route maps it to a 503 `liveError` envelope
 * — the live pin retries the whole connect on the next session mount.
 */
export class LiveTransportError extends Schema.TaggedErrorClass<LiveTransportError>()(
	"fate-live/LiveTransportError",
	{
		method: Schema.String,
		cause: Schema.Defect(),
	},
) {
	override get message(): string {
		return `Live transport for "${this.method}" is warming up — retry shortly.`;
	}
}

/**
 * The runtime shape of alchemy's `RpcCallError` (`Data.TaggedError("RpcCallError")`,
 * `makeRpcStub`'s `tryPromise` catch). The class is internal to alchemy
 * (`Cloudflare/Workers/Rpc`, off the public export path), so we model the seam
 * structurally rather than import it.
 */
interface RpcCallErrorShape {
	readonly _tag: "RpcCallError";
	readonly cause: unknown;
}

/** Tag check for {@link RpcCallErrorShape} — the only seam an unexported class allows. */
const isRpcCallError = (error: unknown): error is RpcCallErrorShape =>
	typeof error === "object" &&
	error !== null &&
	(error as {_tag?: unknown})._tag === "RpcCallError";

/**
 * Capped exponential backoff: ~100ms, 200, 400, 800ms across up to 4 retries
 * (5 attempts total, ~1.5s worst case) — bounded well under the request budget,
 * sized to absorb the sub-second DO warm window without holding the connection.
 */
const coldStartRetrySchedule = Schedule.both(
	Schedule.exponential("100 millis"),
	Schedule.recurs(4),
);

/**
 * Wrap a cross-DO RPC call with the bounded cold-start retry. The runtime
 * `RpcCallError` is absent from the static error channel `E` (the type lie — see
 * module docblock), so we reinterpret to the runtime reality at this single seam,
 * retry ONLY that transport error, and surface a typed {@link LiveTransportError}
 * on exhaustion. Any declared `E` (e.g. `HttpServerError` on the `.fetch`/open
 * path) and any non-transport app error pass through unchanged.
 */
export const withColdStartRetry = <A, E>(
	method: string,
	call: Effect.Effect<A, E, never>,
): Effect.Effect<A, E | LiveTransportError, never> =>
	// Reinterpret the static error channel to the runtime reality (`E` ∪ the hidden
	// transport error) so the retry + `catchIf` narrow against the real failure.
	(call as Effect.Effect<A, E | RpcCallErrorShape, never>).pipe(
		Effect.retry({schedule: coldStartRetrySchedule, while: isRpcCallError}),
		Effect.catchIf(isRpcCallError, (error) =>
			Effect.fail(new LiveTransportError({method, cause: error.cause})),
		),
	);
