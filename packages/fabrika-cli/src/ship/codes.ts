/**
 * Exit allocations for ship. See ./command.ts help for caller semantics.
 * Shared meanings stay imported so their values cannot drift.
 * Review's ACL and append-only allocations stay unused here; ship performs neither.
 */

import {
	BARE_AT_PATH as SHARED_BARE_AT_PATH,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	LEAKED_PATH as SHARED_LEAKED_PATH,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";
import {LABEL_ABSENT as PLAN_LABEL_ABSENT} from "../plan/codes.ts";
import {
	INCOMPLETE_SCAN as REVIEW_INCOMPLETE_SCAN,
	STALE_HEAD as REVIEW_STALE_HEAD,
} from "../review/codes.ts";
import {OFF_VOCABULARY as TRIAGE_OFF_VOCABULARY} from "../triage/codes.ts";

export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
export const LEAKED_PATH = SHARED_LEAKED_PATH;
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/**
 * Zero scope: the target is **proven absent (404)**, the PR is closed/draft where the verb requires
 * an open one, or it has zero changed files — a gate with nothing to judge refuses, never passes.
 *
 * *Proven* is the operative word — a 404 is a fact about the repository, an unreachable GitHub is
 * not a fact about anything and lands on {@link PRECONDITION_UNKNOWN}.
 */
export const ZERO_SCOPE = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
export const OFF_VOCABULARY = TRIAGE_OFF_VOCABULARY;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

export const STALE_HEAD = REVIEW_STALE_HEAD;
export const INCOMPLETE_SCAN = REVIEW_INCOMPLETE_SCAN;

/**
 * Refused: the target is **proven not in the state this write acts on** — nothing was mutated.
 *
 * Neither {@link ZERO_SCOPE} (the target exists) nor {@link PRECONDITION_UNKNOWN} (nothing failed).
 * It is structural: the verb that mutates re-derives its own precondition and declines.
 */
export const PROVEN_NOT_IN_STATE = 16;
/**
 * Refused: the nudge's close landed and the reopen is **unconfirmed — the PR may be left closed**.
 *
 * The group's one two-legged mutation, and the one state so much worse than a failed write that
 * folding it into {@link WRITE_UNKNOWN} would hide the fact the operator must act on immediately.
 */
export const NUDGE_REOPEN_UNCONFIRMED = 17;

/**
 * Refused: the diff touches a governance root and its `governance` verdict is **not** a head-bound
 * PASS — `absent`, `stale` or `fail` (`ship floor`).
 *
 * Its own seat rather than a fold into {@link PROVEN_NOT_IN_STATE}, because a CI job keys on it: this
 * is the one refusal a red check means "a human owes this PR a governance verdict", and every other
 * non-zero from that job means the floor could not be resolved at all.
 */
export const GOVERNANCE_FLOOR_UNMET = 18;

/**
 * Refused: the repository permits **no** merge method at all — `ship merge` has nothing to land with.
 *
 * Its own seat rather than a fold into {@link PROVEN_NOT_IN_STATE}, which `ship merge` already
 * spends on the queue-governed base: those two refusals route opposite ways. A queue-governed base
 * sends the run onward to `ship enqueue`; a repository with squash, merge-commit and rebase all
 * disabled sends it to a human with repository-settings access and ends the lane there. One code
 * carrying both would make the caller parse a message to know which.
 */
export const NO_LANDING_METHOD = 19;

/**
 * Refused: a label this run would POST is absent from the repository's taxonomy.
 *
 * `plan`'s seat, imported, under `plan`'s own rule — *import a code when two groups prove the same
 * fact*. `plan flip` and `ship release` prove one fact here, on one board, over the same taxonomy:
 * the label the write is about to create does not exist, so the write would mint it. The operator
 * drives both in one sweep, and two verbs proving one fact on two codes is the collision that bites.
 *
 * Not {@link ZERO_SCOPE}, which `triage apply`/`park` reach for the same refusal: this group
 * documents `7` as the **target** proven absent, and the target here — the PR, the linked issue —
 * exists. Folding an absent label into it would make `7` two facts in one group.
 */
export const LABEL_ABSENT = PLAN_LABEL_ABSENT;

/**
 * Refused: every check run at the head passed and **not one workflow this repo authors produced a
 * run there**, so no gate of the repo's own inspected the bytes `ship` would merge.
 *
 * `review`'s `16` proves the same fact, and this group does not import it: `16` here is
 * {@link PROVEN_NOT_IN_STATE}, a meaning `ship` allocated first, so the two groups seat one fact on
 * two numbers rather than one number on two meanings.
 */
export const NO_GATE_COVERAGE = 20;

/**
 * The unallocated codes. `4` is `report file`'s body-section seat and `14`/`15` are `review`'s ACL
 * and append-only seats; no verb here performs any of the three. Excluded from the alignment
 * check's allocations — reading a gap as an allocation reports a collision on a seat nobody sits in.
 */
export const DELIBERATE_GAP = 4;
