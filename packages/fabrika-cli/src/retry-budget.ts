/**
 * The one repair-retry budget in fabrika — how many retries a failing task gets before its loop
 * freezes, and the round at which that freeze lands.
 *
 * The number lived three times with three values (#5732): `build/rounds.ts`'s `ROUND_CAP = 3`,
 * `lane/emit.ts`'s `MAX_RETRIES = 2` beside the coder template's `maxRetries: 2`, and
 * `review/append-criterion-verb.ts`'s `FREEZE_ROUND = 3`. The lane machine's is the survivor
 * because it is the only one a transition enforces (`retries < maxRetries` in the compiled cell)
 * rather than a caller remembering to check; the others read it from here, so a PR driven by a lane
 * and the same PR read through `build verdicts` cannot disagree about whether the loop is capped.
 *
 * `lane/templates/coder.workflow.json` is JSON and cannot import — `retry-budget.unit.test.ts`
 * fails closed if the committed template or an emitted epic machine drifts off {@link RETRY_BUDGET}.
 */

/** The retries a failing task gets. The one declared budget; everything else derives from it. */
export const RETRY_BUDGET = 2;

/** The round the budget is spent at, so the loop freezes — ADR 0079's K, derived, never a second number. */
export const CAP_ROUND = RETRY_BUDGET + 1;
