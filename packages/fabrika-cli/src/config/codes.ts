/**
 * The exit table `config schema` allocates from.
 *
 * `0`, `1` and `127` are the interface convention's reserved codes (`../verb.ts`); everything here is
 * `3` and up, the band a verb owns for outcomes it PROVED. The shape mirrors `wire index`, the sibling
 * verb that reconciles a generated file against the registry it is derived from.
 */

/** The committed schema file and the registry disagree — regenerate with `--write`. */
export const SCHEMA_DRIFT = 4;
/** The committed schema file could not be read or written — UNKNOWN, never a disagreement. */
export const IO_UNKNOWN = 6;
/**
 * Zero scope: a registered key carries no schema fragment, so the assembled schema would be
 * incomplete. Named rather than emitted over, because a schema missing a key's subtree greens a typo
 * under it — the silent gap this schema exists to close.
 */
export const INCOMPLETE_REGISTRY = 7;
