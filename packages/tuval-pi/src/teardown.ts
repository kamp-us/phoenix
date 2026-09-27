/**
 * The ceiling every Pi finalizer that waits on something outside Effect runs under.
 *
 * A scope finalizer is uninterruptible, so a wait inside one that never settles hangs the close for
 * good — there is no interrupt left to cut it and the operator's stop never returns (#7896). The
 * ceiling is a timer beside the wait rather than `Effect.timeout` over it: timing out needs the
 * region to be interruptible, and an interruptible finalizer is skipped outright when the stop
 * itself arrived as an interrupt, which trades a hang for a leak. Neither `http.Server.close` nor
 * `Client.dispose` takes an `AbortSignal`, so a bound is the only shape available to them.
 */

import {Duration, Effect} from "effect";

export const TEARDOWN_CEILING = Duration.seconds(5);

/**
 * Wait for `register` to report settled, or give the wait up at `ceiling`.
 *
 * Expiry logs and returns rather than failing: a socket the runtime never reported closed is a
 * worse outcome than nothing, and a far better one than a stop that never returns. A `register`
 * that throws synchronously ends the wait the same way, because `Effect.callback` calls it with no
 * try/catch of its own (`internal/effect.js`'s `callbackOptions`, `const onCancel = register(…)`,
 * at the rc.112 pin): an escaping throw would leave this uninterruptible finalizer with the ceiling
 * timer still armed and no `resume` ever taken. `Client.dispose()` is the live case — it is not
 * `async`, and its body rejects pending requests, disconnects the transport and disposes the state
 * synchronously before the promise is returned (`pi-client@0.84.3`, `dist/client.js` line 292).
 */
export const boundedTeardown = (
	what: string,
	register: (settled: () => void) => void,
	ceiling: Duration.Duration = TEARDOWN_CEILING,
): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		let done = false;
		const finish = (outcome: Effect.Effect<void>): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resume(outcome);
		};
		const timer = setTimeout(
			() =>
				finish(
					Effect.logWarning(
						`teardown gave up waiting on ${what} after ${Duration.toMillis(ceiling)}ms`,
					),
				),
			Duration.toMillis(ceiling),
		);
		// biome-ignore lint/plugin: `register` is a foreign callback rather than an effect, so `Effect.try` cannot wrap it without giving up the `resume` this whole callback is built around; the throw is folded into the ceiling's own outcome instead of modelled as a failure.
		try {
			register(() => finish(Effect.void));
		} catch (cause) {
			finish(Effect.logWarning(`teardown's wait on ${what} threw`, cause));
		}
	});
