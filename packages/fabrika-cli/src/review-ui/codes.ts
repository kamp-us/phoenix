/**
 * Exit allocations for review-ui. See ./command.ts help for caller semantics.
 * Shared meanings stay imported so their values cannot drift.
 * Shared allocations also let this group reuse ../review/target.ts and ../review/authored.ts guards.
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
 * A required file this group derives from is absent, does not parse, or violates its schema — a
 * capture set's `manifest.json`, or the declared `uiCapture` at the tier-choice read.
 *
 * The base's section seat, widened to the whole-file rule the `ui` group states: a document read
 * for a decision is read whole, and a half-read one decides nothing.
 */
export const MALFORMED_DOCUMENT = SHARED_BAD_SECTIONS;
export const LEAKED_PATH = SHARED_LEAKED_PATH;
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/** An absent target is proven; a failed read must use PRECONDITION_UNKNOWN. */
export const ZERO_SCOPE = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
export const OFF_VOCABULARY = SHARED_CLASSIFIED;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/**
 * Refused, proven: the artifact is not the PR's current tree.
 *
 * One meaning binds the two triggers — the live head moved past `--sha` at post time, or the
 * preview's deployed head is not the live head at render time — because *the pixels or the marker
 * would bind a tree that is not the PR*, and the caller's move is identical either way: re-render,
 * re-review at the live head.
 */
export const STALE_TREE = 12;
export const RENDER_CRASHED = 13;
export const SURFACE_UNREACHABLE = 14;
export const INVALID_CAPTURE = 15;
export const NO_PREVIEW = 16;
export const UPLOAD_FAILED = 17;
/**
 * Refused: this post would retire a standing verdict of the OPPOSITE polarity at the same head, and
 * `--supersede` was not passed.
 *
 * Its own seat rather than {@link OFF_VOCABULARY}, because nothing about the arguments is off any
 * vocabulary — the write is legitimate and one flag away. What it costs is the record: a standing
 * FAIL silently became a PASS with nothing showing a gate had blocked, and the host keeps no
 * comment-body history to recover it from. Nothing is posted on this refusal — the evidence
 * uploads of step 4 have already run by then, which is a spent upload rather than a landed verdict.
 */
export const SUPERSEDES_VERDICT = 18;
/**
 * Refused, proven: a shot's PNG width, read back from its own bytes, is not the width of the
 * viewport that was asked for.
 *
 * Its own seat rather than the wrong-page `11`, because unlike a wrong tier or an inert override
 * this one is decided against the recorded artifact rather than against a probe the preview
 * answered — the readback is the same shape as `INVALID_CAPTURE`'s, one question further on. A shot
 * at the wrong width is a valid PNG of a layout nobody asked about, and recording it under a
 * viewport label would make the narrow half of the design law answerable from desktop pixels.
 */
export const WRONG_VIEWPORT = 19;
