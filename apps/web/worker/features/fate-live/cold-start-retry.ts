/**
 * Cold-start resilience for the cross-DO `LiveDO` RPC seam (#842). The RPC surface
 * declares `never` failure channels, but alchemy's stub injects a runtime
 * `RpcCallError` the static type erases — see ADR 0095 and
 * `.patterns/alchemy-durable-objects.md`. The GET SSE-open `.fetch` path is a second
 * channel: alchemy wraps it in an uncaught `Effect.promise`, so the same cold-DO
 * rejection arrives as a DEFECT and must be lifted before the shared retry sees it
 * (#1048). Schedule shape grounds in Effect-TS/effect `LLMS.md` §"Working with Schedules".
 */
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/** The route maps this to a 503 `liveError` envelope, never a defect-500 (ADR 0095). */
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
 * Modeled structurally because alchemy's `RpcCallError` is off its public export path
 * and cannot be imported as a value or a type. Grounded in alchemy
 * `Cloudflare/Workers/Rpc.ts`: `Data.TaggedError("RpcCallError")<{method: string; cause:
 * unknown}>`. An upstream rename can therefore never be a compile failure here — the
 * unit test pins this fixture against the cited source instead.
 */
interface RpcCallErrorShape {
	readonly _tag: "RpcCallError";
	readonly method?: string;
	readonly cause: unknown;
}

const isRpcCallError = (error: unknown): error is RpcCallErrorShape =>
	typeof error === "object" &&
	error !== null &&
	(error as {_tag?: unknown})._tag === "RpcCallError";

/**
 * The `.fetch` defect channel has no positive discriminant: alchemy's
 * `fromCloudflareFetcher` server branch passes the cold-DO rejection through opaquely
 * (no `_tag`, no `.retryable`), and its later `Effect.map(HttpServerResponse.fromWeb)`
 * step dies the same way on a malformed response. So this guard is deliberately
 * NEGATIVE (#1367): it re-raises only the V8 code-defect classes — which a transport
 * layer never throws to signal a rejection — and lets everything else be retried.
 *
 * `TypeError` is deliberately EXCLUDED even though a marshaling die can be one: the
 * genuine cold-DO rejection is a bare `Error`/`TypeError` too, so re-raising it would
 * regress the ADR 0095 cold-start retry. The channel is not perfectly precise and
 * cannot be; this only flips the default from "mask every defect" to "fail fast on the
 * unambiguous code defects".
 */
export const isNonTransportDefect = (cause: unknown): boolean =>
	cause instanceof RangeError ||
	cause instanceof ReferenceError ||
	cause instanceof SyntaxError ||
	cause instanceof EvalError ||
	cause instanceof URIError;

/** ~1.5s worst case: sized to absorb the sub-second DO warm window, well under the request budget. */
const coldStartRetrySchedule = Schedule.both(
	Schedule.exponential("100 millis"),
	Schedule.recurs(4),
);

/**
 * The runtime `RpcCallError` is absent from the static channel `E`, so the cast below
 * reinterprets `E` to the runtime reality (`E` ∪ the hidden transport error) — the one
 * seam where that error is actually present. Non-transport errors pass through untouched.
 */
export const withColdStartRetry = <A, E>(
	method: string,
	call: Effect.Effect<A, E, never>,
): Effect.Effect<A, E | LiveTransportError, never> =>
	retryTransportFailure(
		method,
		call as Effect.Effect<A, E | RpcCallErrorShape, never>,
	) as Effect.Effect<A, E | LiveTransportError, never>;

/**
 * The GET SSE-open twin of {@link withColdStartRetry}: `.fetch` surfaces a cold-DO
 * rejection as a DEFECT, which the failure-channel key never sees (#1048), so it is
 * lifted into the same `RpcCallError` shape. The lift is guarded, not blanket — an
 * unambiguous code defect ({@link isNonTransportDefect}) is re-raised so it fails fast
 * as a 500 rather than being masked as a retried 503. The declared `E` (the
 * request-framing channel) passes through untouched: the route deliberately `orDie`s
 * that, and lifting it would mask a real framing defect as a cold start.
 */
export const withColdStartRetryFetch = <A, E>(
	method: string,
	call: Effect.Effect<A, E, never>,
): Effect.Effect<A, E | LiveTransportError, never> =>
	retryTransportFailure(
		method,
		call.pipe(
			Effect.catchDefect((cause) =>
				isNonTransportDefect(cause)
					? Effect.die(cause)
					: Effect.fail({_tag: "RpcCallError", cause} satisfies RpcCallErrorShape),
			),
		) as Effect.Effect<A, E | RpcCallErrorShape, never>,
	) as Effect.Effect<A, E | LiveTransportError, never>;

const retryTransportFailure = <A, E>(
	method: string,
	call: Effect.Effect<A, E | RpcCallErrorShape, never>,
): Effect.Effect<A, Exclude<E, RpcCallErrorShape> | LiveTransportError, never> =>
	call.pipe(
		Effect.retry({schedule: coldStartRetrySchedule, while: isRpcCallError}),
		Effect.catchIf(isRpcCallError, (error) =>
			Effect.fail(new LiveTransportError({method, cause: error.cause})),
		),
	) as Effect.Effect<A, Exclude<E, RpcCallErrorShape> | LiveTransportError, never>;
