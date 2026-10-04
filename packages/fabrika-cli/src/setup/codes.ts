/**
 * Exit allocations for `setup`. The command seats no code of its own: a run that stops carries the
 * refusing step's code, and every step is a `status bootstrap` surface, so this table is that
 * group's, re-exported rather than restated.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10494
 */
export * from "../status/codes.ts";
