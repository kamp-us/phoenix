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
 * THE SECOND CHANNEL (#1048): the GET SSE-open path does NOT go through
 * `makeRpcStub`'s `tryPromise`. The stub's `.fetch` is alchemy's
 * `fromCloudflareFetcher.fetch`, whose server-shaped branch wraps the cross-DO
 * call in `Effect.promise(() => fetcher.fetch(request))` with NO catch — so a
 * cold-DO transport rejection surfaces as a DEFECT (die), not an `RpcCallError`
 * failure. The defect slips past {@link withColdStartRetry} (it keys on the
 * FAILURE channel) and the route's `LiveTransportError`→503 boundary, escaping as
 * a raw HTTP 500. {@link withColdStartRetryFetch} closes the seam: it lifts a
 * cold-DO transport defect into the same `RpcCallError`-shaped failure the RPC
 * methods raise, so the ONE bounded-retry + `LiveTransportError` path covers both
 * channels.
 *
 * THE DISCRIMINANT PROBLEM (#1367): the defect channel has NO clean positive
 * discriminant, unlike the RPC channel's `isRpcCallError` tag-check. Grounded in
 * alchemy `Cloudflare/Fetcher.ts` `fromCloudflareFetcher`: the server branch is
 * `pipe(…, Effect.flatMap(Effect.promise(fetcher.fetch)), Effect.map(HttpServerResponse.fromWeb))`
 * with no `Effect.catch`. So TWO unrelated failures both surface here as an
 * indistinct die: (a) the cold-DO transport rejection (the `Effect.promise`
 * rejects), and (b) a marshaling die from the later `Effect.map` step
 * (`HttpServerResponse.fromWeb` throwing on a malformed response). A BLANKET
 * `Effect.catchDefect` that lifts EVERY defect as the transport error would
 * reinterpret (b) as a transient 503 and retry it 5× — re-opening, inverted, the
 * exact failure-masking ADR 0095 closed on the RPC channel. But the promise
 * rejection carries no `_tag` and no documented `.retryable` flag (verified absent
 * from `@cloudflare/workers-types`), so no positive "this IS the cold-DO rejection"
 * predicate exists; and re-raising every *unrecognized* defect would instead
 * re-raise the genuine (also opaque) cold-DO rejection and regress the ADR 0095
 * resilience. The reconciliation is {@link isNonTransportDefect}: a CONSERVATIVE
 * guard that re-raises only the V8 code-defect classes — which a transport layer
 * never throws to signal a rejection — and lifts the residual. See its docblock
 * for the residual this leaves and why it is the safe arm.
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
 * The runtime shape of alchemy's `RpcCallError`, modeled structurally because the
 * class is internal to alchemy (`Cloudflare/Workers/Rpc`, off the public export
 * path) and cannot be imported as a value or a type.
 *
 * GROUNDED against the dep source: alchemy `Cloudflare/Workers/Rpc.ts` defines
 * `RpcCallError = Data.TaggedError("RpcCallError")<{readonly method: string;
 * readonly cause: unknown}>`, raised by `makeRpcStub`'s
 * `Effect.tryPromise({catch: (cause) => new RpcCallError({method, cause})})`. The
 * `method` field is part of alchemy's real emitted shape — modeled here (not just
 * `{_tag, cause}`) so this interface mirrors the dep's contract faithfully and the
 * unit test can pin against the true field set (#1367 facet 2). Because the class
 * is unexported, an upstream rename/rewrap cannot be a phoenix *compile* failure;
 * the pin is a unit assertion against this grounded fixture, kept in sync with the
 * cited `Rpc.ts` source.
 */
interface RpcCallErrorShape {
	readonly _tag: "RpcCallError";
	readonly method?: string;
	readonly cause: unknown;
}

/** Tag check for {@link RpcCallErrorShape} — the only seam an unexported class allows. */
const isRpcCallError = (error: unknown): error is RpcCallErrorShape =>
	typeof error === "object" &&
	error !== null &&
	(error as {_tag?: unknown})._tag === "RpcCallError";

/**
 * The conservative defect guard for the `.fetch` channel (#1367). Returns `true`
 * for a defect that is PROVABLY not a cold-DO transport rejection, so the caller
 * re-raises it (fail-fast 500) instead of masking it as a retried 503.
 *
 * The match set is the V8 *code-defect* constructors — `RangeError` (stack
 * overflow, invalid length), `ReferenceError` (undefined access), `SyntaxError`
 * (parse, incl. a JSON marshaling die), `EvalError`, `URIError`. These are thrown
 * by buggy code (e.g. alchemy's `Effect.map(HttpServerResponse.fromWeb)` step on a
 * malformed response), never by a transport layer to signal that a cold/unreachable
 * DO rejected — workerd surfaces DO transport/readiness failures as a plain `Error`
 * (e.g. "Network connection lost."), not one of these subclasses. So re-raising
 * them carries ZERO risk of regressing the ADR 0095 cold-start retry.
 *
 * RESIDUAL (documented, not hidden): `TypeError` is deliberately EXCLUDED. A
 * marshaling die can be a `TypeError`, but so can a network-shaped rejection, and
 * since the genuine cold-DO rejection is itself opaque (a bare `Error`/`TypeError`
 * with no discriminant), re-raising `TypeError` would risk regressing AC3 (the
 * cold-start path must still fire). It — and any bare `Error` — therefore stays in
 * the retried bucket. This guard does not make the channel perfectly precise (no
 * predicate can, given alchemy passes the rejection through opaquely); it flips the
 * default from "mask EVERY defect" to "fail fast on the unambiguous code defects",
 * which is the safe, grounded improvement over the prior blanket catch.
 */
export const isNonTransportDefect = (cause: unknown): boolean =>
	cause instanceof RangeError ||
	cause instanceof ReferenceError ||
	cause instanceof SyntaxError ||
	cause instanceof EvalError ||
	cause instanceof URIError;

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
	retryTransportFailure(
		method,
		call as Effect.Effect<A, E | RpcCallErrorShape, never>,
	) as Effect.Effect<A, E | LiveTransportError, never>;

/**
 * Wrap the GET SSE-open `.fetch` cross-DO call. Unlike the RPC methods, `.fetch`
 * surfaces a cold-DO transport rejection as a DEFECT (alchemy's
 * `Effect.promise`-wrapped fetcher — see module docblock §"THE SECOND CHANNEL",
 * #1048), so {@link withColdStartRetry}'s failure-channel key never sees it. We
 * lift a transport defect into an `RpcCallError`-shaped FAILURE, then route it
 * through the identical bounded-retry + {@link LiveTransportError} path — so the
 * open path warms up and renders 503 exactly like the RPC seam, never a raw 500.
 *
 * GUARDED, not blanket (#1367): an unambiguous code defect ({@link isNonTransportDefect}
 * — a marshaling/`Effect.map` die, etc.) is RE-RAISED unchanged so it fails fast as
 * a 500, never masked as a retried 503. Only the residual defect is lifted as the
 * transport failure. See §"THE DISCRIMINANT PROBLEM" for why this conservative arm
 * is the safe one and the residual it leaves.
 *
 * The declared `E` (the `.fetch` `HttpServerError`/`RequestError` request-framing
 * channel) passes through untouched: the route deliberately `orDie`s that (a real
 * framing defect), and lifting it would wrongly mask it as a cold-start retry.
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

/**
 * The shared bounded-retry + convert both wrappers above reuse: retry ONLY the
 * `RpcCallError`-shaped transport failure (capped backoff), then map a surviving
 * one to the typed {@link LiveTransportError}. Any other channel member passes
 * through unchanged.
 */
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
