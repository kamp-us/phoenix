/**
 * The ceiling every Pi finalizer that waits on something outside Effect runs under.
 *
 * A scope finalizer is uninterruptible, so a wait inside one that never settles hangs the close for
 * good — there is no interrupt left to cut it and the operator's stop never returns (#7896). The
 * ceiling is a timer beside the wait rather than `Effect.timeout` over it: timing out needs the
 * region to be interruptible, and an interruptible finalizer is skipped outright when the stop
 * itself arrived as an interrupt, which trades a hang for a leak. Neither `http.Server.close` nor
 * `PiClient.dispose` takes an `AbortSignal`, so a bound is the only shape available to them.
 */

import {Duration, Effect} from "effect";

export const TEARDOWN_CEILING = Duration.seconds(5);

/**
 * Wait for `register` to report settled, or give the wait up at `ceiling`.
 *
 * Expiry logs and returns rather than failing: a socket the runtime never reported closed is a
 * worse outcome than nothing, and a far better one than a stop that never returns.
 */
export const boundedTeardown = (
	what: string,
	register: (settled: () => void) => void,
	ceiling: Duration.Duration = TEARDOWN_CEILING,
): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		let done = false;
		const finish = (expired: boolean): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resume(
				expired
					? Effect.logWarning(
							`teardown gave up waiting on ${what} after ${Duration.toMillis(ceiling)}ms`,
						)
					: Effect.void,
			);
		};
		const timer = setTimeout(() => finish(true), Duration.toMillis(ceiling));
		register(() => finish(false));
	});
