/**
 * The one exit table all eight `heal-ci` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it (`claude-plugins/fabrika/skills/heal-ci/contract.md`).
 *
 * **Every shared seat is imported, never re-typed as a numeral.** `3`-`11` come from
 * `../exit-codes.ts` and `12`/`13` from `../review/codes.ts`, whose meanings this group holds
 * unchanged — the import-not-restate idiom `../ship/codes.ts` already ships. A restated numeral is a
 * second source that can drift silently; an import cannot.
 *
 * `14`, `15` and `16` are this group's own proven refusals. They mean something different here than
 * `ship`'s `16`/`17` or `review`'s `14`/`15`, which is the doctrine rather than a collision: the `3`+
 * band is scoped to the group that seats it, and `../exit-code-alignment.ts` checks every group
 * against the base alone.
 *
 * `0`, `1`, `2`, `126` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`)
 * and none of them is available to a verb-specific meaning.
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

/** Stdin was read and held nothing — `heal-ci classify`, `heal-ci note`. */
export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
/** The **authored** text carries a machine-local path — `heal-ci note`. */
export const LEAKED_PATH = SHARED_LEAKED_PATH;
/** The **authored** text is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/**
 * Zero scope: the target is **proven absent (404)**, or a required input is proven empty where
 * emptiness is not a fact (ADR 0092).
 *
 * *Proven* is the operative word, and this group leans on it hard: a 404 is a fact about the
 * repository, an unreachable GitHub is not a fact about anything and lands on
 * {@link PRECONDITION_UNKNOWN}.
 */
export const ZERO_SCOPE = SHARED_NO_TARGET;
/** The write, or the read that confirms it, failed — the outcome is **UNKNOWN**. */
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
/** The write landed but the read-back does not match. */
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/**
 * A supplied value is off a closed vocabulary — an unknown `--signature` (`rerun`), an unknown
 * `--class` (`note`), or a `--slug` that is not one kebab-case path segment (`scratch`).
 */
export const OFF_VOCABULARY = SHARED_CLASSIFIED;
/** A **precondition read failed** — nothing was proven and (for a write) nothing was written. */
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/** Refused: the live head moved past the inspected `--sha` — `review`'s seat, same meaning. */
export const STALE_HEAD = REVIEW_STALE_HEAD;
/** Refused: a read completed but its scope is **provably incomplete** — `review`'s seat. */
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
