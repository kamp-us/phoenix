/**
 * How many times a driver may re-fold a lane that is waiting on something outside it, before the
 * wait escalates to a human — and how long each of those re-folds has to wait for its turn.
 *
 * It is deliberately NOT [`RETRY_BUDGET`](retry-budget.ts). A retry is a repair round — the lane failed and is
 * spending a chance to fix itself — and a wait is a lane that did nothing wrong sitting behind a
 * merge queue. Riding one counter would make a PR that dwelt in the queue arrive at its first real
 * FAIL with no repair rounds left, which is a budget spent on a queue's clock rather than on the
 * work. The two counters therefore stay separate.
 *
 * The value is four observations of the same wait: the shipper's own bounded watch, then three
 * driver re-folds. The wait that forced this bound sat ~13m45s against the shipper's ~480s horizon,
 * so a bound of three covers roughly four horizons without ever letting the wait run open-ended.
 *
 * **The budget is floored as well as counted.** A count alone measures driver speed: lane 6915 spent
 * two of its three waits inside roughly ninety seconds while its PR was clean and simply queued, so
 * the third pass would have parked a person over a dwell this pipeline calls normal. Each re-fold
 * now has to clear {@link WAIT_FLOOR_SECONDS} of elapsed time before `lane report` will record it —
 * see ADR
 * [0313](../../../.decisions/0313-a-queue-dwell-is-a-wait-not-a-park.md)'s 2026-08-29 amendment.
 */

/** The re-folds a waiting task gets before its wait escalates to a human park. */
export const WAIT_BUDGET = 3;

/**
 * The elapsed seconds a queue re-fold must clear before `lane report` will record it.
 *
 * The value is the shipper's own watch horizon and not a number of its own: `ship reconcile --wait`
 * defaults to 16 polls at 30s (`ship/command.ts`), which its `horizon = polls * cadenceSeconds`
 * (`ship/reconcile-verb.ts`) makes 480s. Anchoring here is what keeps {@link WAIT_BUDGET}'s own
 * docblock true — three floored re-folds after the shipper's watch really are four observations of
 * the same wait, spanning roughly four horizons of elapsed time rather than four driver passes.
 */
export const WAIT_FLOOR_SECONDS = 480;
