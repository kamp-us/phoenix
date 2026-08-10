/**
 * The one exit table all six `glossary` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it (`claude-plugins/fabrika/skills/glossary/contract.md`).
 *
 * The overlap with `report` is **imported, never re-typed**: an aligning group takes the base's
 * constant, so a drift is unrepresentable rather than merely detectable.
 *
 * Three meanings on this table are one another's opposites and the whole group is built to keep them
 * apart: `1`/`127` is *the call never decided*, {@link PRECONDITION_UNKNOWN} is *a precondition read
 * failed and nothing was written*, and {@link WRITE_UNKNOWN} is *a write was attempted and its
 * outcome is UNKNOWN*. Everything at `3` and above is something a verb **proved** — with nothing on
 * stdout.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

import {
	BAD_SECTIONS as REPORT_BAD_SECTIONS,
	CLASSIFIED as REPORT_CLASSIFIED,
	EMPTY_STDIN as REPORT_EMPTY_STDIN,
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as REPORT_READBACK_MISMATCH,
	WRITE_UNKNOWN as REPORT_WRITE_UNKNOWN,
} from "../report/codes.ts";

/** Stdin was read and held nothing. `glossary add --definition-file -` only — the one fd 0 read. */
export const EMPTY_STDIN = REPORT_EMPTY_STDIN;
/**
 * The register was read and a structure this verb needs — its term table, or its headings — is
 * unusable.
 *
 * A register with **no** term table at all is zero rows, never this: absence is `bootstrap` and an
 * empty table is the verb's zero-row behaviour. Only a table that exists and is malformed lands here.
 */
export const BAD_SECTIONS = REPORT_BAD_SECTIONS;
/**
 * Held empty. Machine-local paths in a register are decided by the merge-blocking leak gate over
 * changed markdown, and a second answer here could report clean while that gate reds.
 *
 * `6` is held empty for the same reason — dead internal links belong to the repo-wide link gate — and
 * carries no export at all, because `../exit-code-alignment.ts` matches this one exact name and a
 * second export of it would not compile while a renamed one would read as an allocation.
 */
export const DELIBERATE_GAP = 5;
/** Proven: a judging verb scanned nothing it could judge (ADR 0092). */
export const ZERO_SCOPE = REPORT_NO_TARGET;
/** A register write was attempted and its outcome could not be proven — UNKNOWN, deliberately not `1`. */
export const WRITE_UNKNOWN = REPORT_WRITE_UNKNOWN;
/** The write landed and the re-read differs from what was composed; the register needs a human. */
export const READBACK_MISMATCH = REPORT_READBACK_MISMATCH;
/**
 * A closed-enum flag carried an off-enum value — `--register` outside its vocabulary, or `both` where
 * a verb writes and a term has exactly one register.
 *
 * A semantic refusal on a *value*; a malformed *flag* stays `1`, which is the parser's.
 */
export const OFF_VOCABULARY = REPORT_CLASSIFIED;
/** A precondition read failed; nothing was written and no outcome is proven. */
export const PRECONDITION_UNKNOWN = REPORT_PRECONDITION_UNKNOWN;

/** Proven: the term is already declared and `--replace` was not given — `add` refused. */
export const TERM_COLLISION = 12;
/** Proven: `--section` names no heading in the register. */
export const SECTION_ABSENT = 13;
/** Proven: the composed row cannot be a well-formed table row. */
export const ROW_SHAPE_INVALID = 14;
/** Proven: the edit would have changed a line outside the target row — aborted, nothing written. */
export const EDIT_BEYOND_ROW = 15;
