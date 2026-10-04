/**
 * Exit allocations for `config schema`; caller semantics are in `./command.ts` help.
 */

export const SCHEMA_DRIFT = 4;
export const IO_UNKNOWN = 6;
/**
 * Zero scope: a registered key carries no schema fragment, so the assembled schema would be
 * incomplete. Named rather than emitted over, because a schema missing a key's subtree greens a typo
 * under it — the silent gap this schema exists to close.
 */
export const INCOMPLETE_REGISTRY = 7;
