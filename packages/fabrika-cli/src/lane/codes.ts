/**
 * The one exit table every `lane` verb allocates from, so a code means one thing across the group.
 *
 * The five shared seats are **imported from the base, never re-typed** — the discipline
 * `../exit-code-alignment.ts` checks. The lane verbs read a local lane directory and append to its
 * log, so the base's facts they can establish are exactly these: the target is not there, the
 * target was read but is not the shape, the write did not land, a marker landed and does not read
 * back, the read that would have proven any of that failed. `12`+ is this group's own band.
 *
 * **A fold that could not be made never resolves to a plausible state.** An absent lane, an
 * unreadable one, and a lane whose bytes parse but contradict the machine stay distinct codes,
 * because they take opposite remedies: open the lane, fix the tree, fix the record.
 */

import {
	BAD_SECTIONS as REPORT_BAD_SECTIONS,
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as REPORT_READBACK_MISMATCH,
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
 * The append did not land, or `lane claim`'s marker write did not. The caller refuses; it never
 * reports the event as recorded, nor the claim as held.
 */
export const APPEND_UNKNOWN = REPORT_WRITE_UNKNOWN;

/**
 * `lane claim`'s marker landed and does not read back as the token this run posted. The comment
 * exists, so it is neither a failed write nor a lost race — it needs a human eye.
 */
export const MARKER_READBACK = REPORT_READBACK_MISMATCH;

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

/**
 * The artifact the event claims is **provably not there**: no open pull request traces to the
 * task's issue and the issue is not one a no-PR outcome is legal on, or — on an epic run's child,
 * which opens no PR (ADR 0285) — no branch in this tree carries commits naming the child. The event
 * is a self-report nothing corroborates, so the remedy is to route the spawn's outcome as blocked,
 * not to record it.
 *
 * The four proof seats are **artifact-independent**: what a caller must do about "not there", "not
 * finished", "says the other thing" and "several candidates" does not change with the kind of
 * artifact, so the range arms allocate no fifth seat — nor does `lane brief`, which reads a child's
 * range off the same tree before it dispatches a reviewer at it (#6023).
 */
export const PROOF_ABSENT = 22;

/**
 * The artifacts are there but not terminal — a required namespace with no verdict that still binds,
 * whether by head (a PR verdict) or by content digest (a child's range verdict, ADR 0276). Its own
 * seat because the remedy is the opposite of {@link PROOF_ABSENT}'s: re-read until the review
 * finishes, record nothing in the meantime (`operate` step 3's in-flight rule).
 */
export const PROOF_IN_FLIGHT = 23;

/**
 * The artifact is there and says the other thing — a still-binding `FAIL` under a claimed `PASS`.
 * Distinct again by remedy: the caller has the event wrong and the machine has a cell for the one
 * the artifact actually supports.
 */
export const PROOF_CONTRADICTED = 24;

/**
 * Several candidates trace to the task: several open pull requests linking its issue, or several
 * lane branches carrying an epic child's commits. Which one the lane owns is not derivable, and
 * picking one would record a DONE against another lane's work — or brief a reviewer at another
 * lane's range — a park, never a guess.
 */
export const PROOF_AMBIGUOUS = 25;

/**
 * The tree is not standing on the run's assembly branch — a detached HEAD, or another branch checked
 * out. Refused before anything is pushed: the branch name is derived from the epic number, so a push
 * from anywhere else would publish a tree this run never assembled.
 */
export const WRONG_BRANCH = 26;

/**
 * The push would not fast-forward — the local head does not contain the published assembly head, so
 * it would drop commits the remote already carries. The assembly branch only ever grows (every
 * landing is a merge onto it), so no force path exists and no flag opens one: the remedy is to fetch
 * and re-merge, never to overwrite.
 *
 * `27` and `28` are skipped rather than taken: the base already speaks for both
 * (`report`'s `QUEUE_UNREADABLE` and `SEARCH_UNREADABLE`), and `exit-code-alignment.ts` reds on a
 * private code that collides with one of the base's.
 */
export const UNSAFE_PUSH = 29;

/**
 * Proven: the push ran and the remote ref is **not** at the local head. Its own seat rather than
 * {@link APPEND_UNKNOWN}'s, because "it did not land" and "whether it landed is unreadable" take
 * opposite remedies — push again, versus re-read before touching anything.
 */
export const REF_NOT_MOVED = 30;

/**
 * Proven: this session does not hold the driver's claim on the lane — another driver won the race,
 * or there is no claim to release. Its own seat rather than `build`'s `15`, which this group already
 * spends on {@link TOPOLOGY_ABSENT}; the two prove different facts and share no remedy.
 *
 * Proven-unclaimed sits here too, on `build claim`'s reading: zero markers means this session does
 * not hold the lane, which is the one fact a driver acts on. The stderr detail keeps unclaimed and
 * foreign apart for a reader; the code does not, because the caller stops either way.
 */
export const CLAIM_NOT_MINE = 31;

/**
 * The token handed to `lane report` is no shell's terminal token — the map in `report.ts` holds no
 * entry for it, so no event can be derived and the log is left unappended. Its own seat rather than
 * {@link EVENT_REFUSED}'s because the remedy differs: pass a token from your shell skill's closed
 * vocabulary, not a different event — silently interpreting an unknown token is the failure class
 * this verb exists to delete (#5736).
 */
export const TOKEN_UNRECOGNISED = 32;
