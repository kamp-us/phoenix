/**
 * The one exit table the three `review-ui` verbs allocate from, so a code means one thing across
 * this group whichever verb produced it.
 *
 * **The seats it shares with `report` are re-exported, never re-typed** — the discipline
 * `review/codes.ts` states and the reason `ALIGNED_GROUPS` can check it: a restated numeral is a
 * second source that drifts silently, an import cannot. Nine seats are shared here (`3`-`11`); `12`
 * and up are this group's own.
 *
 * Because these seats are the base's by identity, this group also **imports** the two generic
 * guards the `review` group parameterized — `review/target.ts`'s PR precondition and
 * `review/authored.ts`'s stdin/leak guard — rather than copying them: both seat exactly these
 * numbers, and a second copy of a fail-closed guard is a second chance to fold *absent* into
 * *unreadable*.
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

/** Stdin was read and held nothing. Distinct from a read that failed, which is `1`. */
export const EMPTY_STDIN = REPORT_EMPTY_STDIN;
/**
 * A required file this group derives from is absent, does not parse, or violates its schema — a
 * capture set's `manifest.json`, or `design-harness.json` at the tier-choice read.
 *
 * The base's section seat, widened to the whole-file rule the `ui` group states: a document read
 * for a decision is read whole, and a half-read one decides nothing.
 */
export const MALFORMED_DOCUMENT = REPORT_BAD_SECTIONS;
/** The **authored** text carries a machine-local path. This group offers no `--redact`. */
export const LEAKED_PATH = REPORT_LEAKED_PATH;
/** The authored text is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = REPORT_BARE_AT_PATH;
/**
 * Zero scope: the target is **proven absent (404)**, or the PR is closed.
 *
 * The same declared widening the `review` group makes — a closed PR is provably not reviewable
 * scope. *Proven* is the operative word: a 404 is a fact about the repository, an unreachable
 * GitHub is not a fact about anything and lands on {@link PRECONDITION_UNKNOWN}.
 */
export const ZERO_SCOPE = REPORT_NO_TARGET;
/** A write was attempted and its outcome could not be proven — UNKNOWN, deliberately not `1`. */
export const WRITE_UNKNOWN = REPORT_WRITE_UNKNOWN;
/** The write landed but the read-back does not match. The artifact exists and needs a human. */
export const READBACK_MISMATCH = REPORT_READBACK_MISMATCH;
/** A semantic refusal on a value or a body: off a closed vocabulary, or a marker-shaped note. */
export const OFF_VOCABULARY = REPORT_CLASSIFIED;
/** A required read or execution failed — no outcome is proven, and nothing was written. */
export const PRECONDITION_UNKNOWN = REPORT_PRECONDITION_UNKNOWN;

/**
 * Refused, proven: the artifact is not the PR's current tree.
 *
 * One meaning binds the two triggers — the live head moved past `--sha` at post time, or the
 * preview's deployed head is not the live head at render time — because *the pixels or the marker
 * would bind a tree that is not the PR*, and the caller's move is identical either way: re-render,
 * re-review at the live head (ADR 0058).
 */
export const STALE_TREE = 12;
/** Proven: at least one surface threw an uncaught page error — the render is red (#2594). */
export const RENDER_CRASHED = 13;
/** Proven: at least one surface is unreachable — status ≥ 400 or a failed navigation. */
export const SURFACE_UNREACHABLE = 14;
/** Proven: a capture was produced but is invalid — zero bytes, undecodable, or zero area. */
export const INVALID_CAPTURE = 15;
/** Proven: no preview deployment exists for this PR — the skill's CANT-SEE route (#4305). */
export const NO_PREVIEW = 16;
/** Proven: at least one evidence upload or its verification failed — **nothing was posted**. */
export const UPLOAD_FAILED = 17;
