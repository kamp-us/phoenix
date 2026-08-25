/**
 * The one exit table all four `handoff` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it (`claude-plugins/fabrika/skills/handoff/contract.md`).
 *
 * The overlap with `report` is **re-exported, never re-typed**: an aligning group imports the base's
 * constant, so a drift is unrepresentable rather than merely detectable. This group shares eight
 * seats over `3`-`9` and `11`, and adds `12`-`15` for facts about a pack — whether the work it
 * points at is reachable, whether a pack exists, whether it parses, and whether someone already
 * holds it.
 *
 * Seat `10` is the one seat this group deliberately leaves empty. The base's `10` fires when a title
 * or label carries a type or priority classification; no `handoff` verb accepts a label flag, writes
 * a label, or composes a title, so the condition is unreachable rather than merely unused.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
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

/** Stdin was read and held nothing. `handoff take` only — the one verb that reads fd 0. */
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
/** The composed document carries a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/** Proven: the issue does not exist. */
export const NO_TARGET = SHARED_NO_TARGET;
/** A write was attempted and its outcome could not be proven — UNKNOWN, deliberately not `1`. */
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
/** The write landed and the read-back differs. The artifact exists and needs a human. */
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/** The aligned classification seat, held empty. See the module docblock for why it is unreachable. */
export const DELIBERATE_GAP = SHARED_CLASSIFIED;
/** A precondition read failed, so nothing was written and no outcome is proven. */
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
/** Proven: the issue carries no sealed pack to claim. `handoff claim` only. */
export const NO_PACK = 13;
/** Proven: a sealed pack exists and does not parse, or its digest disagrees with the fields it labels. */
export const PACK_MALFORMED = 14;
/** Proven: another nonce holds the latest pack's claim. */
export const PACK_CLAIMED = 15;
