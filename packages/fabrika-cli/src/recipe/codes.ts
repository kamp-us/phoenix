/**
 * The one exit table every `recipe` verb allocates from, so a code means one thing across the group.
 *
 * The five shared seats are **imported from the base, never re-typed** — the discipline
 * `../exit-code-alignment.ts` checks. A recipe verb reads a lane or a pull request, applies a fixed
 * fix, and reads the fix back, so the base's facts it can establish are exactly these: the target is
 * not there, the target was read but is not the shape, the write did not land, the write landed and
 * the read-back contradicts it, the read that would have proven any of that failed. `12`+ is this
 * group's own band.
 *
 * **The known/novel split is an exit code, never prose** (#5847). A recipe either matched and its
 * fixed fix applied, or it did not match and nothing was touched — and those two are different
 * numbers, because the caller routes autonomously on the first and to a human on the second.
 */

import {
	BAD_SECTIONS as SHARED_BAD_SECTIONS,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

/**
 * The target is proven absent: no lane under the lanes root, or a pull request that does not exist
 * or is closed. The base's target seat — the thing the verb was pointed at is not there to act on.
 */
export const TARGET_ABSENT = SHARED_NO_TARGET;

/**
 * A record was read in full and is not the shape: a `workflow.json` the lane compiler refuses, an
 * `events.jsonl` line that does not parse, or a log the machine cannot replay. The base's section
 * seat widened to a whole on-disk record, on the `lane` precedent.
 */
export const MALFORMED_RECORD = SHARED_BAD_SECTIONS;

/** The fix's own write did not land. The verb never reports the recipe as applied. */
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;

/**
 * The write landed and the read-back contradicts it — the lane did not leave the park, or the
 * rerun's own run record shows no new attempt. The artifact moved and needs a human.
 */
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;

/**
 * A precondition read failed, so nothing was written and no outcome is proven. UNKNOWN, never a
 * permissive reading: the read is what makes every proven code above *proven*.
 */
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/**
 * The park's cause is outside the known-recipe set. **Nothing was mutated** — the verb refuses
 * before it would touch the log, which is what makes the novel exit a proven no-op rather than a
 * claim about one. This is the seat the founder's grill answer sits on (epic #5840): known clears
 * autonomously, novel routes to a human, and the split lives here rather than in operator prose.
 */
export const PARK_NOVEL = 12;

/**
 * The park matched a known recipe and the recipe's clearing condition is not met yet — the §CP
 * approval this park waits on is still outstanding. Its own seat rather than {@link PARK_NOVEL}
 * because the remedy differs: wait for the named signal and re-run, do not route a human at the
 * recipe.
 */
export const PARK_HOLDS = 13;

/** The task's leaf state is not a park — there is nothing to clear, and nothing was written. */
export const NOT_PARKED = 14;

/**
 * The task the recipe was addressed to is not in this lane's machine, `--task` was omitted on a lane
 * with more than one task, or neither the task nor the lane names the issue the park hangs on.
 */
export const TASK_UNRESOLVED = 15;

/** The pull request carries no `governance` verdict at all. The remedy is forming one. */
export const VERDICT_ABSENT = 16;

/**
 * A `governance` verdict is there and is bound to another head. Never folded into
 * {@link VERDICT_ABSENT}: "the PASS is old" and "nobody judged this" take opposite remedies, and
 * folding them is how a stale PASS comes to authorise a rerun at a head it never saw.
 */
export const VERDICT_STALE = 17;

/** The `governance` verdict at the current head is FAIL. Nothing is rerun. */
export const VERDICT_FAIL = 18;

/** No workflow run at the pull request's head concluded in failure — there is nothing to rerun. */
export const NOTHING_TO_RERUN = 19;

/**
 * The lane machine refused the `UNBLOCKED` the recipe would have recorded, and the log is left
 * unappended. Distinct from {@link WRITE_UNKNOWN}: the append never happened by decision, not by
 * fault, so the remedy is the lane's state and not the filesystem.
 */
export const UNPARK_REFUSED = 20;

/**
 * The rerun was requested and its outcome could not be re-read, so whether it was accepted is
 * UNKNOWN. Distinct from {@link READBACK_MISMATCH}, which is a read-back that succeeded and
 * disagreed: here nothing is proven in either direction and the remedy is reading the run.
 */
export const RERUN_UNKNOWN = 21;

/**
 * The chore state `recipe route` was asked about applies no recipe — `queued`, a park, a final, or a
 * name nobody registered. It is `route`'s own refusal and never a recipe run's outcome, so
 * [`drive.ts`](./drive.ts) seats no event for it: the operator acts on that state itself (`operate`
 * §2's table), and a chore drive that ran *some* verb there would be guessing.
 */
export const NO_RECIPE = 22;
