/**
 * Exit allocations for `decision`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts`. Unused shared codes stay unallocated: this group
 * accepts no stdin or arbitrary body text, and its marker URL grammar admits no local path.
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
 * promise with none of the same proof manufactures a lane that parks at `build claim` exit 32.
 */
export const CRITERIA_REQUIRED = SHARED_BAD_SECTIONS;

export const NO_TARGET = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/**
 * Proven: the invoking account may not rule a decision here — it is outside the control-plane
 * roster resolved from CODEOWNERS at write time, or that roster names nobody at all.
 *
 * Its own seat rather than `plan`'s `APPROVAL_UNAUTHORIZED` (24) even though the fact reads alike:
 * the two are proved by different verbs over different subjects, and a caller driving both in one
 * sweep reads an exit code off the command that produced it. What would make an import mandatory is
 * two verbs proving *the same* fact — `plan approve` proves an account may not approve one epic's
 * plan, which no `decision` verb can produce, and vice versa.
 */
export const RULING_UNAUTHORIZED = 20;
