/**
 * Exit allocations for heal-ci. See ./command.ts help for caller semantics.
 * Shared meanings stay imported so their values cannot drift.
 */

import {
	BAD_SECTIONS as SHARED_BAD_SECTIONS,
	BARE_AT_PATH as SHARED_BARE_AT_PATH,
	CLASSIFIED as SHARED_CLASSIFIED,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	LEAKED_PATH as SHARED_LEAKED_PATH,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";
import {
	INCOMPLETE_SCAN as REVIEW_INCOMPLETE_SCAN,
	STALE_HEAD as REVIEW_STALE_HEAD,
} from "../review/codes.ts";

/**
 * The base's body-section seat, held empty.
 *
 * It is `report file`'s, and filing is `report`'s verb: this group specifies no filing verb and
 * composes no body sections, so the condition is unreachable rather than merely unused.
 */
export const DELIBERATE_GAP = SHARED_BAD_SECTIONS;

export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
export const LEAKED_PATH = SHARED_LEAKED_PATH;
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/** An absent target is proven; a failed read must use PRECONDITION_UNKNOWN. */
export const ZERO_SCOPE = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
export const OFF_VOCABULARY = SHARED_CLASSIFIED;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

export const STALE_HEAD = REVIEW_STALE_HEAD;
export const INCOMPLETE_SCAN = REVIEW_INCOMPLETE_SCAN;

/**
 * Refused: **proven not in the state this write acts on** — nothing was mutated.
 *
 * Neither {@link ZERO_SCOPE} (the target exists) nor {@link PRECONDITION_UNKNOWN} (nothing failed).
 * It is v1's `rerun-once.sh` scar made structural: the guard lives in the verb, so a caller that has
 * convinced itself a second rerun is warranted still cannot get one.
 *
 * Both write verbs seat here, for the same reason in two shapes: `rerun` on a head already rerun,
 * `note` on a pull request already carrying a note at this `<pr>:<class>:<head>` key.
 */
export const PROVEN_NOT_IN_STATE = 14;
/**
 * Refused: the run's logs are **proven unavailable** — expired or purged by the platform.
 *
 * A fact about the run, not a failed read. Folding it into {@link PRECONDITION_UNKNOWN} would tell
 * the caller to retry a read that can never succeed.
 */
export const LOGS_EXPIRED = 15;
/**
 * The rerun **provably landed** and its durable marker could not be written.
 *
 * The loudest code in the group: the at-most-once invariant is live but unrecorded, so the next
 * reader sees a head that looks un-rerun. Folding it into {@link WRITE_UNKNOWN} would hide the one
 * fact an operator must act on immediately.
 */
export const RERUN_UNRECORDED = 16;
