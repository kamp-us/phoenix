/**
 * Exit allocations for `ui`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts`; allocation checks live in `../exit-code-alignment.ts`.
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

/** The aligned stdin seat, held empty: no `ui` verb reads stdin, so nothing else may sit here. */
export const DELIBERATE_GAP = SHARED_EMPTY_STDIN;

export const BAD_SECTIONS = SHARED_BAD_SECTIONS;
export const LEAKED_PATH = SHARED_LEAKED_PATH;
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
export const ZERO_SCOPE = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
export const OFF_VOCABULARY = SHARED_CLASSIFIED;
/**
 * A required read or execution failed — no outcome is proven.
 *
 * A stated widening of the report seat, which covers precondition reads only: here it also seats a
 * harness that never became ready and a capture whose validity could not be determined, because
 * both leave the render UNKNOWN in exactly the way a failed read leaves a target UNKNOWN.
 */
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

export const NO_MANIFEST = 12;
export const UNTYPED_LAW = 13;
export const RENDER_CRASHED = 14;
export const SURFACE_UNREACHABLE = 15;
export const CAPTURE_INVALID = 16;
export const UPLOAD_FAILED = 17;
/**
 * Proven: the lane precondition failed — this session does not hold the claim the checked-out lane
 * branch names (foreign, none, or an unparseable branch).
 *
 * Deliberately `ui`-local rather than borrowing `build`'s `15`: the two groups' matrices diverge
 * above `11` by the established doctrine, and folding this onto a `build` number would tie one
 * group's seat allocation to the other's.
 */
export const LANE_NOT_MINE = 18;
export const NO_UI_SURFACE = 19;
