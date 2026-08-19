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
 * **The cap is the round after the highest cleared one, not the declared cap plus a tally.** Adding
 * one per grant held that invariant only when the grant landed at exactly {@link CAP_ROUND}: a
 * clearance stamped at round 4 with no prior grant raised the cap to 4, so `capReached(4, [4])` was
 * still true and the granted round could not be built (#6137, which parked #6122 with an honoured
 * clearance buying nothing). Taking the maximum is the same number whenever the grants are the
 * contiguous run from `CAP_ROUND` up, and the right one when they are not.
 *
 * A round below {@link CAP_ROUND} is never counted. Nothing can be cleared before the budget is
 * spent, so such a marker is either hand-written or from a drifted writer, and counting it would
 * silently widen the cap by a round nobody granted.
 */

import {CAP_ROUND, RETRY_BUDGET} from "./retry-budget.ts";

/** The recorded rounds that are grants at all: whole numbers at or past the declared cap. */
const honoured = (cleared: ReadonlyArray<number>): ReadonlyArray<number> =>
	cleared.filter((round) => Number.isInteger(round) && round >= CAP_ROUND);

/**
 * How many distinct rounds a set of recorded clearances names — what a scope line reports.
 *
 * Distinct rounds, not markers: two clearances stamped at the same round clear the same round, so a
 * double-posted grant — a re-run, a reconciled write — can never read as two.
 */
export const grantedRounds = (cleared: ReadonlyArray<number>): number =>
	new Set(honoured(cleared)).size;

/** The highest round a clearance names, or `null` when nothing was cleared. */
export const highestCleared = (cleared: ReadonlyArray<number>): number | null => {
	const rounds = honoured(cleared);
	return rounds.length === 0 ? null : Math.max(...rounds);
};

/** The freeze round for a declared cap, given what has been cleared — the derivation both readers take. */
export const capWith = (declaredCap: number, cleared: ReadonlyArray<number>): number => {
	const highest = highestCleared(cleared);
	return highest === null ? declaredCap : Math.max(declaredCap, highest + 1);
};

/** The round the loop freezes at, given what has been cleared. */
export const effectiveCap = (cleared: ReadonlyArray<number>): number => capWith(CAP_ROUND, cleared);

/** The retries a lane task holds, given what has been cleared. One below the cap it freezes at. */
export const effectiveBudget = (cleared: ReadonlyArray<number>): number =>
	budgetWith(RETRY_BUDGET, cleared);

/**
 * The retries a lane task with its own declared budget holds. The lane guard fires at
 * `retries >= maxRetries`, one round below the cap, so the two readers spend one grant identically.
 */
export const budgetWith = (declaredBudget: number, cleared: ReadonlyArray<number>): number =>
	capWith(declaredBudget + 1, cleared) - 1;

/** Whether the repair loop is out of budget — the one field `build`'s Repair section trusts. */
export const capReached = (rounds: number, cleared: ReadonlyArray<number>): boolean =>
	rounds >= effectiveCap(cleared);

/**
 * The one phrase both verbs put the cap on a scope line with.
 *
 * Written as the derivation actually runs — the round after the highest grant — so an operator
 * reading it can check the arithmetic against the markers instead of against a tally that no longer
 * explains the number (#6137).
 */
export const capNote = (cleared: ReadonlyArray<number>): string => {
	const highest = highestCleared(cleared);
	return highest === null
		? `cap ${effectiveCap(cleared)} = ${CAP_ROUND} declared, nothing cleared`
		: `cap ${effectiveCap(cleared)} = the round after cleared round ${highest} (${CAP_ROUND} declared, ${grantedRounds(cleared)} cleared round(s))`;
};
