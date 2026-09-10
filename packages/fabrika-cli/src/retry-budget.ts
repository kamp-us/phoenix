/**
 * The one repair-retry budget in fabrika — how many retries a failing task gets before its loop
 * freezes, and the round at which that freeze lands.
 *
 * The number lived three times with three values: `build/rounds.ts`'s `ROUND_CAP = 3`,
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

/** The round the budget is spent at, so the loop freezes — derived, never a second number. */
export const CAP_ROUND = RETRY_BUDGET + 1;

/**
 * The laps a task gets on MACHINERY failures before it parks to its driver with a cause.
 *
 * Deliberately not {@link RETRY_BUDGET}, on the same reasoning that keeps `wait-budget.ts`'s
 * `WAIT_BUDGET` off it: a retry is a repair round — the artifact was judged and found wrong — and a
 * lap is the pipeline's own machinery failing to carry a correct artifact through. A child colliding
 * at integrate, the trunk drifting under an epic tail, a queue ejection, a seat left dirty: none of
 * them says anything about the work, and every one of them used to spend a repair round. One epic
 * run cleared its whole budget that way without a single content FAIL behind it.
 *
 * A spent lap parks with a cause rather than freezing, because a machinery failure is residue a
 * driver owns rather than a verdict a builder must answer.
 *
 * The value is the founder's, ruled on the walk that opened this axis and revisited in the weekly
 * machinery review against counted laps on real runs — it is a tuning dial, not a derivation.
 */
export const MACHINERY_LAP_BUDGET = 16;
