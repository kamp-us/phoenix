/**
 * Exit allocations for `handoff`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts`. Code 10 stays unallocated because no verb
 * accepts a classification label or composes a title.
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

export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
/**
 * A required section is missing, out of order or empty, **or the document carries content outside
 * the closed set**.
 *
 * The second clause is this group's widening of the base seat, and it is the load-bearing one: an
 * open section set lets an author append a paragraph a successor reads as part of the format. It is
 * declared rather than silent because an imported constant quietly carrying a second meaning is the
 * drift the import exists to stop; the seat keeps the base's name and number, and the trigger set
 * grows only in the fail-closed direction.
 */
export const BAD_SECTIONS = SHARED_BAD_SECTIONS;
/**
 * The composed document carries a machine-local path.
 *
 * **A stated widening of the base seat, which reads "…and `--redact` was not given".** No `handoff`
 * verb offers `--redact`, so here the refusal fires unconditionally. The condition narrows; the
 * meaning does not drift.
 */
export const LEAKED_PATH = SHARED_LEAKED_PATH;
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
export const NO_TARGET = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/** The aligned classification seat, held empty. See the module docblock for why it is unreachable. */
export const DELIBERATE_GAP = SHARED_CLASSIFIED;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/**
 * Proven: the work is unreachable by a successor and the loss was not declared.
 *
 * Allocated rather than imported from `build`'s `13 DIRTY_TREE`, which is the near miss: this proves
 * a **different** fact — unreachable *to a successor*, which is an unpushed head **or** a modified
 * tracked file, and which `--declare-unreachable` waives. This group's `12` and `build`'s (retired,
 * left empty) are two namespaces rather than a collision (`../plan/codes.ts`: import a code when two
 * groups prove the same fact; allocate freely when they do not).
 */
export const WORK_UNREACHABLE = 12;
export const NO_PACK = 13;
export const PACK_MALFORMED = 14;
export const PACK_CLAIMED = 15;
