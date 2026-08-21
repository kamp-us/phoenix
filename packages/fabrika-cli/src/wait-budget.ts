/**
 * How many times a driver may re-fold a lane that is waiting on something outside it, before the
 * wait escalates to a human.
 *
 * It is deliberately NOT [`RETRY_BUDGET`](retry-budget.ts). A retry is a repair round — the lane failed and is
 * spending a chance to fix itself — and a wait is a lane that did nothing wrong sitting behind a
 * merge queue. Riding one counter would make a PR that dwelt in the queue arrive at its first real
 * FAIL with no repair rounds left, which is a budget spent on a queue's clock rather than on the
 * work (ADR 0313).
 *
 * The value is four observations of the same wait: the shipper's own bounded watch, then three
 * driver re-folds. #6178 sat ~13m45s against the shipper's ~480s horizon, so a bound of three
 * covers roughly four horizons without ever letting the wait run open-ended.
 */

/** The re-folds a waiting task gets before its wait escalates to a human park. */
export const WAIT_BUDGET = 3;
