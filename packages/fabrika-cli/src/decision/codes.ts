/**
 * The one exit table both `decision` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it.
 *
 * The overlap with `report` is **re-exported, never re-typed** — the discipline `grill/codes.ts` and
 * `build/codes.ts` state in full: an aligning group imports the base's constant, so a drift is
 * unrepresentable rather than merely detectable. This group shares five seats and adds one of its
 * own for the fact neither `report` nor any other group proves.
 *
 * Four of the base's seats are deliberately left empty rather than given a second meaning. No verb
 * here reads stdin (`3`) or classifies a label or a title (`10`) — the group writes exactly one
 * audience label pair and one marker whose every field is a digest, a URL or a stamp. And nothing it
 * composes carries free human text, so the two redaction seats (`5`, `6`) are unreachable too: the
 * marker's only caller-supplied field is a URL matched against the `#issuecomment-` grammar, which
 * admits no machine-local path and no bare `@` reference.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

import {
	BAD_SECTIONS as SHARED_BAD_SECTIONS,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

/**
 * Proven: the ruled issue's body carries no readable `### Acceptance criteria` block, so the
 * audience flip was skipped and the issue stays on `ready-for:human`. The marker still stands.
 *
 * `report`'s own seat for a body whose sections do not hold up, and the same fact here: `triage
 * apply` already refuses `--ready-for agent` over such a body, and a flip written under the same
 * promise with none of the same proof manufactures a lane that parks at `build claim` exit 32
 * (#6734).
 */
export const CRITERIA_REQUIRED = SHARED_BAD_SECTIONS;

/** Proven absent: the issue does not exist, is a pull request, or is not a `type:decision`. */
export const NO_TARGET = SHARED_NO_TARGET;
/** The write failed and may or may not have landed — re-read the issue before retrying. */
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
/** The write landed and does not read back as what was sent. */
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/** A precondition could not be read — the roster, the comments, the invoking account. Never a state. */
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

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
