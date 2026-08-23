/**
 * The shared exit-code registry — the one table every aligning group reads from, this group
 * included.
 *
 * The seats below are the meanings more than one verb group proves the same way: an empty stdin,
 * a malformed document, a leaked path, a proven-absent target, an UNKNOWN write, a mismatched
 * read-back, an off-vocabulary value, an unreadable precondition. Each is defined here exactly
 * once; every `<group>/codes.ts` that speaks one of these facts imports the constant rather than
 * restating a numeral, so a drift is unrepresentable rather than merely detectable. Which groups
 * claim which of these seats, and what each may add privately, is classified in
 * {@link ./exit-code-alignment.ts} — the registry holds the numbers, the alignment module holds the
 * law about them.
 *
 * History: this table lived at `report/codes.ts` until it didn't. The writing verbs shipped first,
 * so every later group seated itself against *their* module — which made one group's file the de
 * facto constitution and left `report` importing its own law secondhand through everyone else.
 * The table moved here so no group owns it, not even the one that wrote it first (#5296 is why the
 * numbers below are dense from `3`: they were aligned under `report`'s private band, and `27`/`28`
 * stay spoken for by that group to this day).
 *
 * `0`, `1` and `127` are the interface convention's reserved codes (see `../verb.ts`) and are
 * deliberately **not** defined here — a registry of proven outcomes has nothing to say about a
 * failure to invoke, and `2` is allocated by nothing anywhere (`../hook/codes.ts` carries that
 * hard rule).
 */

/** Stdin was read and held nothing. Distinct from a read that failed, which is `1`. */
export const EMPTY_STDIN = 3;
/** A required section is missing, out of order, or empty. */
export const BAD_SECTIONS = 4;
/** The text carries a machine-local path headed for a public artifact. */
export const LEAKED_PATH = 5;
/**
 * The text is a bare `@` path reference — **not** redactable.
 *
 * Separate from {@link LEAKED_PATH} because the fixes are opposite: the caller's loop on a path
 * refusal is *re-run with `--redact`*, and on a body that IS a path that loop never terminates.
 */
export const BARE_AT_PATH = 6;
/**
 * Zero scope over a named target: the target is proven absent or closed, or there is nothing to
 * judge (ADR 0092). Groups whose reading widens this to any empty judged scope alias it locally
 * (`ZERO_SCOPE`); the seat is the base's either way.
 */
export const NO_TARGET = 7;
/**
 * A write was attempted and its landing cannot be proven — the outcome is **UNKNOWN**,
 * deliberately not `1`.
 *
 * A create or comment call that times out may or may not have landed. Seating that on `1` would
 * make "the write was refused" indistinguishable from "the binary is broken", which is the
 * verdict-versus-invocation collision the reserved range exists to prevent (#4208, #4219).
 */
export const WRITE_UNKNOWN = 8;
/** The write landed but the read-back does not match. The artifact exists and needs a human. */
export const READBACK_MISMATCH = 9;
/** A supplied value is off its closed vocabulary, or claims a classification it may not. */
export const CLASSIFIED = 10;
/**
 * A precondition read failed, so nothing was written and no outcome is proven.
 *
 * Allocated its own code rather than folded into an existing one (#4752's class): the failed read
 * is what makes {@link NO_TARGET} and {@link CLASSIFIED} *proven*, so a failed read of it can be
 * neither. It is not {@link WRITE_UNKNOWN} — nothing was attempted — and not `1`, which would fuse
 * an unreachable backend with a bad flag.
 */
export const PRECONDITION_UNKNOWN = 11;
