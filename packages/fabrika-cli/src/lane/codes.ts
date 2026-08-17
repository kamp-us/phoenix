/**
 * The one exit table every `lane` verb allocates from, so a code means one thing across the group.
 *
 * The four shared seats are **imported from the base, never re-typed** — the discipline
 * `../exit-code-alignment.ts` checks. The lane verbs read a local lane directory and append to its
 * log, so the base's facts they can establish are exactly these: the target is not there, the
 * target was read but is not the shape, the write did not land, the read that would have proven any
 * of that failed. `12`+ is this group's own band.
 *
 * **A fold that could not be made never resolves to a plausible state.** An absent lane, an
 * unreadable one, and a lane whose bytes parse but contradict the machine stay distinct codes,
 * because they take opposite remedies: open the lane, fix the tree, fix the record.
 */

import {
	BAD_SECTIONS as REPORT_BAD_SECTIONS,
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
	WRITE_UNKNOWN as REPORT_WRITE_UNKNOWN,
} from "../report/codes.ts";

/**
 * The lane is not there: no `workflow.json` under the lane directory. A proven absence — the lane
 * was never opened. The base's target seat: the thing the verb was pointed at does not exist.
 */
export const LANE_ABSENT = REPORT_NO_TARGET;

/**
 * The lane was read in full and is not the shape: a `workflow.json` the compiler refuses (each
 * defect named), an `events.jsonl` line that does not parse, or a log the machine cannot replay.
 * The base's section seat widened to a whole on-disk record, on the `review-ui` precedent.
 */
export const MALFORMED_RECORD = REPORT_BAD_SECTIONS;

/**
 * The append did not land. The caller refuses; it never reports the event as recorded.
 */
export const APPEND_UNKNOWN = REPORT_WRITE_UNKNOWN;

/**
 * The lane could not be read, or its absence could not be established. UNKNOWN, never a fresh
 * lane: the read is what makes {@link LANE_ABSENT} and {@link MALFORMED_RECORD} *proven*, so a
 * failed read can be neither.
 */
export const LANE_UNREADABLE = REPORT_PRECONDITION_UNKNOWN;

/**
 * The event is refused and the log is left unappended: the machine holds no cell for it in the
 * task's current state (tea's `NoCellError`), the event is outside the operator's six, the task is
 * not in the active phase, or the workflow is already done. A proven refusal — the loud surface
 * XState's silent event-swallowing never gave the reference ledger (#5671, run 8).
 */
export const EVENT_REFUSED = 12;

/**
 * The task the event was addressed to is not in this lane's machine, or `--task` was omitted on a
 * lane with more than one task. Its own seat rather than {@link EVENT_REFUSED} because the remedy
 * differs: name a task the machine has, not a different event.
 */
export const TASK_UNKNOWN = 13;

/**
 * The lane directory is already there — a boot or emit over it is refused with nothing written.
 * Resuming an existing lane needs no boot, and silently overwriting a machine mid-drive would
 * corrupt a live fold (#5688; gate-1 friction item 1 on #5680).
 */
export const LANE_EXISTS = 14;

/**
 * The epic body carries no readable `## Dependencies` topology — there is nothing to emit a machine
 * from. The remedy is planning the epic, so it never shares a seat with a topology that is there
 * and defective.
 */
export const TOPOLOGY_ABSENT = 15;

/** The topology references an issue that is not a child of the epic, and the ref is named. */
export const TOPOLOGY_FOREIGN = 16;

/** The topology's dependency graph holds a cycle, and the ref path is named. */
export const TOPOLOGY_CYCLE = 17;

/**
 * The artifact the event claims is **provably not there**: no open pull request traces to the
 * task's issue, and the issue is not one a no-PR outcome is legal on. The event is a self-report
 * nothing corroborates, so the remedy is to route the spawn's outcome as blocked, not to record it.
 */
export const PROOF_ABSENT = 18;

/**
 * The artifacts are there but not terminal at the head — a required namespace with no current-head
 * verdict. Its own seat because the remedy is the opposite of {@link PROOF_ABSENT}'s: re-read until
 * the review finishes, record nothing in the meantime (`operate` step 3's in-flight rule).
 */
export const PROOF_IN_FLIGHT = 19;

/**
 * The artifact is there and says the other thing — a current-head `FAIL` under a claimed `PASS`.
 * Distinct again by remedy: the caller has the event wrong and the machine has a cell for the one
 * the board actually supports.
 */
export const PROOF_CONTRADICTED = 20;

/**
 * Several open pull requests trace to the task's issue. Which one the lane owns is not derivable,
 * and picking one would record a DONE against another lane's work — a park, never a guess.
 */
export const PROOF_AMBIGUOUS = 21;
