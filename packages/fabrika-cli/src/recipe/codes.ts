/**
 * Exit allocations for recipe. See ./command.ts help for caller semantics.
 * Shared meanings stay imported so their values cannot drift.
 */

import {
	BAD_SECTIONS as SHARED_BAD_SECTIONS,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

export const TARGET_ABSENT = SHARED_NO_TARGET;

/** The shared section code also covers complete on-disk records, as it does in lane. */
export const MALFORMED_RECORD = SHARED_BAD_SECTIONS;

export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;

export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;

export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/**
 * The park's cause is outside the known-recipe set. **Nothing was mutated** — the verb refuses
 * before it would touch the log, which is what makes the novel exit a proven no-op rather than a
 * claim about one. This is the seat the known/novel split sits on: known clears autonomously, novel
 * routes to a human, and the split lives here rather than in operator prose.
 */
export const PARK_NOVEL = 12;

/**
 * The park matched a known recipe and the recipe's clearing condition is not met yet — the approval
 * is outstanding, a tree still holds the branch, the campaign still reads paused. Its own seat rather
 * than {@link PARK_NOVEL}
 * because the remedy differs: wait for the named signal and re-run, do not route a human at the
 * recipe.
 */
export const PARK_HOLDS = 13;

export const NOT_PARKED = 14;

export const TASK_UNRESOLVED = 15;

export const VERDICT_ABSENT = 16;

/**
 * A `governance` verdict is there and is bound to another head. Never folded into
 * {@link VERDICT_ABSENT}: "the PASS is old" and "nobody judged this" take opposite remedies, and
 * folding them is how a stale PASS comes to authorise a rerun at a head it never saw.
 */
export const VERDICT_STALE = 17;

export const VERDICT_FAIL = 18;

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
