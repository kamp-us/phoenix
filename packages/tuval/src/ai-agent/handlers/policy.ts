/**
 * The retry and deadline policy, as a plain record the row declares and a handler reads.
 *
 * #7371's rule is that resilience is declared where a replay can see it, never buried as an opaque
 * `Effect.retry` a handler happens to hold. So the three numbers below ride the program row: one
 * reader can say what this program retries and how long it waits without opening a handler, and a
 * different program declares different numbers without a second handler set.
 *
 * Only the two calls that stand a transport up — `start` and the reconnect that repeats it — are
 * retried. A prompt, an answer, a mode set and a page are operator acts against a session already
 * open: repeating one behind the operator's back is a second send, not a recovery, and the
 * idempotency key exists for the transport's own retry (ruling 2, #7570).
 */

import {type Cause, Effect, Schedule} from "effect";

export interface AiAgentRetryPolicy {
	/** Total tries for a start, the first included. `1` is no retry at all. */
	readonly attempts: number;
	/** Fixed spacing between tries, in milliseconds. */
	readonly backoffMillis: number;
	/** Hard bound on one whole start, retries included, in milliseconds. */
	readonly deadlineMillis: number;
}

export const defaultRetryPolicy: AiAgentRetryPolicy = {
	attempts: 3,
	backoffMillis: 250,
	deadlineMillis: 30_000,
};

/**
 * The declared numbers as the one combinator that applies them. A deadline that fires interrupts
 * the call, so the caller reads it as the timeout it is rather than waiting a second policy out
 * (`Effect.timeout`, `effect/Effect` rc.112: "If the timeout wins, the source effect is
 * interrupted").
 */
export const underPolicy = <A, E, R>(
	self: Effect.Effect<A, E, R>,
	policy: AiAgentRetryPolicy,
): Effect.Effect<A, E | Cause.TimeoutError, R> =>
	self.pipe(
		Effect.retry({
			times: Math.max(0, policy.attempts - 1),
			schedule: Schedule.spaced(policy.backoffMillis),
		}),
		Effect.timeout(policy.deadlineMillis),
	);
