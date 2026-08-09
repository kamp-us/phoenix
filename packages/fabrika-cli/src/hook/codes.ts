/**
 * The one exit table every `hook` verb allocates from.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`). The three seats
 * below keep apart the three ways a harness envelope fails to arrive, which is the whole reason a
 * hook verb needs its own table: "stdin held nothing", "stdin held bytes that are not an envelope"
 * and "fd 0 could not be read" are three different claims, and collapsing any two of them lets a
 * hook report a proven negative over evidence it never saw (ADR 0092).
 *
 * {@link EMPTY_STDIN} is *imported* from `report`, not restated as `3`: it is the same fact the
 * writing verbs already seat there, so the alignment is by identity rather than by assertion
 * (`../exit-code-alignment.ts`). The two private seats sit at `12`+ because everything below is
 * occupied in the base table.
 *
 * Note what is NOT here: a seat for "the verb never ran". `127` is the shell's, and a dispatch that
 * never reached this process cannot allocate from a table this process owns — which is exactly why
 * the dispatch-failure policy lives in the hook declaration and not in a verb
 * (`claude-plugins/fabrika/docs/hook-surface.md`, *The dispatch-failure policy point*).
 */

import {EMPTY_STDIN as REPORT_EMPTY_STDIN} from "../report/codes.ts";

/** The answer is on stdout. Restated because {@link HOOK_EXIT_TABLE} spans the whole matrix. */
const ANSWER = 0;
/** Usage error, or the verb failed to run. */
const FAILED = 1;
/** No implementation could be resolved — the dependency graph never loaded (`../bin.ts`). */
const NO_IMPLEMENTATION = 2;

/** Stdin was read and held nothing. An absent envelope is not an envelope to judge. */
export const EMPTY_STDIN = REPORT_EMPTY_STDIN;

/**
 * Bytes arrived on fd 0 and they are not a harness hook envelope — unparseable JSON, a non-object,
 * or an object missing a field every captured envelope carries. A **proven** negative.
 */
export const MALFORMED_ENVELOPE = 12;

/**
 * fd 0 carried nothing readable, or the read itself failed. The envelope is **UNKNOWN**.
 *
 * Deliberately not {@link MALFORMED_ENVELOPE} and deliberately not `1`: "I could not see it" is not
 * "I saw it and it was wrong", and `1` is also what a bad flag returns, so a proven outcome seated
 * there is unreadable as proof (#4208).
 */
export const ENVELOPE_UNKNOWN = 13;

/**
 * A readable envelope arrived, and it is not the event this verb judges.
 *
 * Kept apart from {@link MALFORMED_ENVELOPE} because the envelope is fine — the *routing* is wrong,
 * which is a declaration bug (a hook wired to an event its verb does not answer), not a bad payload.
 * Seating both on one code would let a mis-wired hook read as a harness that sends garbage.
 */
export const WRONG_EVENT = 14;

/** The verb never ran (unresolved binary). The shell's, not this process's — no constant owns it. */
const NEVER_RAN = 127;

/** One row of the shared matrix: a code and the single meaning it carries across the group. */
export interface ExitCodeRow {
	readonly code: number;
	readonly meaning: string;
}

/** The whole matrix in ascending order — the machine-readable form of the group's exit contract. */
export const HOOK_EXIT_TABLE: ReadonlyArray<ExitCodeRow> = [
	{code: ANSWER, meaning: "the answer is on stdout"},
	{code: FAILED, meaning: "usage error, or the verb failed to run"},
	{code: NO_IMPLEMENTATION, meaning: "no implementation could be resolved"},
	{code: EMPTY_STDIN, meaning: "stdin was read and held nothing"},
	{
		code: MALFORMED_ENVELOPE,
		meaning: "stdin held bytes that are not a harness hook envelope",
	},
	{code: ENVELOPE_UNKNOWN, meaning: "fd 0 could not be read — UNKNOWN, never malformed"},
	{code: WRONG_EVENT, meaning: "the envelope is a harness event this verb does not judge"},
	{code: NEVER_RAN, meaning: "the verb never ran (unresolved binary)"},
];
