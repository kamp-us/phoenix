/**
 * The cron-expression half of the scheduler: parse one 5-field expression at definition, and hand
 * back a `next(after)` the timer Sub arms against.
 *
 * **Why a dependency and not a matcher.** A 5-field matcher is forty lines and every one of them is
 * a calendar edge someone else already got wrong once — `0 0 31 * *` skipping February, `0 0 29 2 *`
 * landing on a leap year, a day-of-month and a day-of-week both restricted meaning *or* rather than
 * *and*. `cron-parser` is the standard one, ships its own declarations, and is pinned through the
 * workspace catalog like every other shared version here. It is this package's only runtime
 * dependency, and it is the only thing in here worth not writing.
 *
 * **Local time.** No `tz` is passed, so an expression means what it says on the machine the desk
 * runs on — `0 7 * * *` is seven in the morning where you are, which is the only reading a laptop
 * scheduler has any business taking.
 *
 * **Seconds.** A 5-field expression is `minute hour day-of-month month day-of-week`; a sixth
 * leading seconds field is accepted, because the parser accepts one, but nothing here asks for it.
 */

import {CronExpressionParser} from "cron-parser";

/**
 * A parsed expression, reduced to the one question the timer asks it: what is the first fire
 * strictly after this instant? Both are values — the string so a dep key and a title can read it,
 * the function so the Sub never re-parses.
 */
export interface Schedule {
	/** The expression as written, which is the dep key and the fallback title. */
	readonly expression: string;
	/** The first fire strictly after `after` (epoch ms, local time). */
	readonly next: (after: number) => number;
}

/**
 * Parse, or refuse. A malformed expression throws *here* — at `cron(...)`, where the config is
 * being written — rather than at the first tick hours later on a desk nobody is watching. The
 * parser's own message is kept, because "Constraint error, got value 99 expected range 0-23" says
 * more about `0 99 * * *` than any wrapper of ours would.
 */
export const parseSchedule = (expression: string): Schedule => {
	let parsed: ReturnType<typeof CronExpressionParser.parse>;
	try {
		parsed = CronExpressionParser.parse(expression);
	} catch (cause) {
		throw new Error(
			`cron: \`schedule\` is not a cron expression: ${expression} — ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		);
	}
	return {
		expression,
		// `reset(date)` re-aims the one parsed expression at an instant and `next()` steps strictly
		// forward from it, so every later question is a walk over fields already parsed. Mutating a
		// captured object is safe here because the only caller is a single-threaded timer that asks,
		// reads, and is done before the next turn of the loop.
		next: (after: number): number => {
			parsed.reset(new Date(after));
			return parsed.next().getTime();
		},
	};
};

/** What `setTimeout` can actually hold. Anything longer wraps to a fire that is immediate. */
const MAX_DELAY = 2_147_483_647;

/**
 * Arm a one-shot timer at the next fire and keep re-arming, calling `tick` each time. Returned is
 * the teardown the Sub hands back.
 *
 * **Drift-safe.** Every fire time is computed from the clock, absolutely — never by adding an
 * interval to the last one — so a slow tick is a late tick and nothing after it moves.
 *
 * **A laptop asleep past a fire time fires once on waking, not once per missed slot.** The next
 * window is computed from `max(scheduled, now)`: a `0 7 * * *` that slept through seven and woke at
 * nine delivers one tick and then aims at seven tomorrow, rather than walking forward one missed
 * morning at a time. Cron reports one run at a time and a catch-up storm would be dropped ticks
 * with extra steps; the honest reading of "you missed it" is "run once, now".
 *
 * **A throwing tick does not stop the clock.** The re-arm happens whether the tick returned or
 * threw, and the error is left to leave the timer callback unswallowed — which is exactly what a
 * throwing dispatch does on the `setInterval` half, and that half keeps firing too. A scheduler
 * that goes quiet for good because one dispatch blew up is the worse failure of the two.
 *
 * **A fire further out than ~24 days is held in chunks**, because `setTimeout` takes a 32-bit
 * delay and a longer one wraps to zero — which is a `0 0 29 2 *` that fires every event loop turn
 * for four years instead of once.
 */
export const armSchedule = (
	schedule: Schedule,
	now: () => number,
	tick: () => void,
): (() => void) => {
	let handle: ReturnType<typeof setTimeout> | undefined;
	let live = true;

	const holdUntil = (at: number): void => {
		if (!live) return;
		const delay = at - now();
		if (delay > MAX_DELAY) {
			handle = setTimeout(() => holdUntil(at), MAX_DELAY);
			return;
		}
		handle = setTimeout(
			() => {
				if (!live) return;
				// The re-arm is in a `finally`, so a `tick` that throws cannot stop the clock: the next
				// fire is already armed by the time the error leaves this callback, and it leaves it
				// unswallowed — uncaught out of a timer callback, exactly where the `setInterval` half
				// puts a throwing dispatch, and that half keeps firing too.
				try {
					tick();
				} finally {
					aimAfter(Math.max(at, now()));
				}
			},
			Math.max(0, delay),
		);
	};

	const aimAfter = (after: number): void => {
		if (!live) return;
		holdUntil(schedule.next(after));
	};

	aimAfter(now());

	return () => {
		live = false;
		if (handle !== undefined) clearTimeout(handle);
	};
};

/**
 * `daily 07:00` for the one shape a person reads at a glance, the expression itself for everything
 * else. A tile has one line; a wrong humanization costs more than an honest `0 9 * * 1-5`.
 */
export const humanize = (expression: string): string => {
	const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expression.trim());
	if (daily === null) return expression;
	const [, minute, hour] = daily;
	return `daily ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
};
