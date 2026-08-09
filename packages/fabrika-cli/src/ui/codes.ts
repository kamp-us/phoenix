/**
 * The one exit table all five `ui` verbs allocate from, so a code means one thing across this group
 * whichever verb produced it (`claude-plugins/fabrika/skills/build-ui/contract.md`).
 *
 * The overlap with `report` is **re-exported, never re-typed** — the discipline `build/codes.ts`
 * states in full: an aligning group imports the base's constant, so a drift is unrepresentable
 * rather than merely detectable. This group shares eight seats over `4`-`11` and adds `12`-`19` for
 * facts about the visual modality — the manifest, the law, the render, the captures, and the lane.
 *
 * Seat `3` is the one seat this group deliberately leaves empty: no `ui` verb reads stdin, and an
 * unused seat is cheaper than a second meaning on a shared number.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

import {
	BAD_SECTIONS as REPORT_BAD_SECTIONS,
	BARE_AT_PATH as REPORT_BARE_AT_PATH,
	CLASSIFIED as REPORT_CLASSIFIED,
	EMPTY_STDIN as REPORT_EMPTY_STDIN,
	LEAKED_PATH as REPORT_LEAKED_PATH,
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as REPORT_READBACK_MISMATCH,
	WRITE_UNKNOWN as REPORT_WRITE_UNKNOWN,
} from "../report/codes.ts";

/** The aligned stdin seat, held empty: no `ui` verb reads stdin, so nothing else may sit here. */
export const DELIBERATE_GAP = REPORT_EMPTY_STDIN;

/** A required section is missing, malformed, empty, or out of place — in a document a verb parses. */
export const BAD_SECTIONS = REPORT_BAD_SECTIONS;
/** The authored text carries a machine-local path, unredacted. */
export const LEAKED_PATH = REPORT_LEAKED_PATH;
/** The authored text is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = REPORT_BARE_AT_PATH;
/** Zero scope: the target is **proven** absent or closed, or there is nothing to judge. */
export const ZERO_SCOPE = REPORT_NO_TARGET;
/** A write was attempted and its outcome could not be proven — UNKNOWN, deliberately not `1`. */
export const WRITE_UNKNOWN = REPORT_WRITE_UNKNOWN;
/** The write landed but the read-back does not match; the artifact exists and needs a human. */
export const READBACK_MISMATCH = REPORT_READBACK_MISMATCH;
/** A value off its closed vocabulary or naming grammar. A malformed *flag* stays `1`. */
export const OFF_VOCABULARY = REPORT_CLASSIFIED;
/**
 * A required read or execution failed — no outcome is proven.
 *
 * A stated widening of the report seat, which covers precondition reads only: here it also seats a
 * harness that never became ready and a capture whose validity could not be determined, because
 * both leave the render UNKNOWN in exactly the way a failed read leaves a target UNKNOWN.
 */
export const PRECONDITION_UNKNOWN = REPORT_PRECONDITION_UNKNOWN;

/** Proven: no design manifest at the convention path — the repo is un-bootstrapped (#4952). */
export const NO_MANIFEST = 12;
/** Proven: the manifest exists but no typed prohibition registry does — the law is untyped. */
export const UNTYPED_LAW = 13;
/** Proven: a surface rendered with an uncaught page error — the render is red. */
export const RENDER_CRASHED = 14;
/** Proven: a surface is unreachable — the route resolved to nothing this tree can render. */
export const SURFACE_UNREACHABLE = 15;
/** Proven: a capture was produced but is invalid — zero bytes, undecodable, or zero area. */
export const CAPTURE_INVALID = 16;
/** Proven: at least one evidence upload failed — nothing was posted. */
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
/** Proven: no render harness is declared — the repo cannot be rendered headlessly. */
export const NO_HARNESS = 19;
