/**
 * The cleared repair round — one founder grant, one extra round, on top of the one declared budget.
 *
 * The cap in `./retry-budget.ts` is enforced in two places that never see each other: `build
 * verdicts` folds `capReached` off the FAIL-marker round count, and the lane machine guards each
 * task with `retries < maxRetries`. A founder clearance used to live only as issue prose, so the
 * round it granted could only land as an edit outside the loop (#5959). This module is the one
 * derivation both readers apply, so a PR read through `build verdicts` and the same PR driven by a
 * lane cannot disagree about whether the loop still has budget.
 *
 * **A grant is keyed by the round it clears, which is what makes it spendable exactly once.** A
 * clearance recorded at round N raises the cap to N+1, so the round it was issued for proceeds; the
 * moment another FAIL lands the count is N+1 and the cap is spent again. Binding the round rather
 * than the head SHA is deliberate — a clearance exists precisely so a *new* head can be pushed, so a
 * head-bound grant would be void the instant it was used.
 *
 * A round below {@link CAP_ROUND} is never counted. Nothing can be cleared before the budget is
 * spent, so such a marker is either hand-written or from a drifted writer, and counting it would
 * silently widen the cap by a round nobody granted.
 */

import {CAP_ROUND, RETRY_BUDGET} from "./retry-budget.ts";

/**
 * How many extra rounds a set of recorded clearances buys.
 *
 * Distinct rounds, not markers: two clearances stamped at the same round clear the same round, so a
 * double-posted grant — a re-run, a reconciled write — can never buy two.
 */
export const grantedRounds = (cleared: ReadonlyArray<number>): number =>
	new Set(cleared.filter((round) => Number.isInteger(round) && round >= CAP_ROUND)).size;

/** The round the loop freezes at, given what has been cleared. {@link CAP_ROUND} plus the grants. */
export const effectiveCap = (cleared: ReadonlyArray<number>): number =>
	CAP_ROUND + grantedRounds(cleared);

/** The retries a lane task holds, given what has been cleared. {@link RETRY_BUDGET} plus the grants. */
export const effectiveBudget = (cleared: ReadonlyArray<number>): number =>
	RETRY_BUDGET + grantedRounds(cleared);

/** Whether the repair loop is out of budget — the one field `build`'s Repair section trusts. */
export const capReached = (rounds: number, cleared: ReadonlyArray<number>): boolean =>
	rounds >= effectiveCap(cleared);
