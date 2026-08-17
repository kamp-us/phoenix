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
 * The task's leaf state routes to no shell — `queued`, `blocked`, a `human:*` park, a final, or a
 * name this machine does not recognise. Its own seat because there is nothing to fix in the lane:
 * the remedy is the driver acting on that state (record an event, clear the park), not a re-run.
 */
export const NO_SHELL = 18;

/**
 * The issue a task drives could not be resolved: neither the task name nor the lane id carries an
 * issue number, or the number they carry is proven absent or closed. Separate from
 * {@link TASK_UNKNOWN}: the task IS in the machine, and what is missing is its ground on the board.
 */
export const ISSUE_UNRESOLVED = 19;

/**
 * Exactly one open PR was required to declare it closes the task's issue and zero or several did.
 * A PR that merely quotes the number in prose is not one of them (#5805). Never
 * resolved by picking the newest: a brief handed the wrong PR sends a shell to judge or merge
 * someone else's work, so the ambiguity is named and the dispatch stops.
 */
export const PR_AMBIGUOUS = 20;

/**
 * The `lane` argument is not a lane key: an empty key, or a `chore:<name>` whose name is not the one
 * shape a chore lane's directory may carry. Refused before any path is joined and before any read,
 * so a name carrying a separator or a traversal never becomes a directory nobody meant.
 */
export const KEY_MALFORMED = 21;
