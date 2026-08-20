/**
 * The one exit table both `decision` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it.
 *
 * The overlap with `report` is **re-exported, never re-typed** — the discipline `grill/codes.ts` and
 * `build/codes.ts` state in full: an aligning group imports the base's constant, so a drift is
 * unrepresentable rather than merely detectable. This group shares four seats and adds one of its
 * own for the fact neither `report` nor any other group proves.
 *
 * Five of the base's seats are deliberately left empty rather than given a second meaning. No verb
 * here reads stdin (`3`), checks a body's sections (`4`), or classifies a label or a title (`10`) —
 * the group writes exactly one audience label pair and one marker whose every field is a digest, a
 * URL or a stamp. And nothing it composes carries free human text, so the two redaction seats (`5`,
 * `6`) are unreachable too: the marker's only caller-supplied field is a URL matched against the
 * `#issuecomment-` grammar, which admits no machine-local path and no bare `@` reference.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

import {
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as REPORT_READBACK_MISMATCH,
	WRITE_UNKNOWN as REPORT_WRITE_UNKNOWN,
} from "../report/codes.ts";

/** Proven absent: the issue does not exist, is a pull request, or is not a `type:decision`. */
export const NO_TARGET = REPORT_NO_TARGET;
/** The write failed and may or may not have landed — re-read the issue before retrying. */
export const WRITE_UNKNOWN = REPORT_WRITE_UNKNOWN;
/** The write landed and does not read back as what was sent. */
export const READBACK_MISMATCH = REPORT_READBACK_MISMATCH;
/** A precondition could not be read — the roster, the comments, the invoking account. Never a state. */
export const PRECONDITION_UNKNOWN = REPORT_PRECONDITION_UNKNOWN;

/**
 * Proven: the invoking account may not rule a decision here — it is outside the
 * `@kamp-us/control-plane` roster resolved from CODEOWNERS at write time, or that roster names
 * nobody at all.
 *
 * Its own seat rather than `plan`'s `APPROVAL_UNAUTHORIZED` (24) even though the fact reads alike:
 * the two are proved by different verbs over different subjects, and a caller driving both in one
 * sweep reads an exit code off the command that produced it. What would make an import mandatory is
 * two verbs proving *the same* fact — `plan approve` proves an account may not approve one epic's
 * plan, which no `decision` verb can produce, and vice versa.
 */
export const RULING_UNAUTHORIZED = 20;
