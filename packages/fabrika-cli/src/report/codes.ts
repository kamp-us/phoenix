/**
 * The one exit table `report file`, `report note` and `report amend` allocate from, so a code means
 * the same thing whichever verb produced it. A verb that cannot reach a code leaves it unused rather than
 * compacting the range — a gap is cheaper than a collision.
 *
 * `0`, `1` and `127` are the interface convention's reserved codes (see `../verb.ts`); everything
 * here is `3` and up, the band a verb owns for outcomes it PROVED.
 */

/** Stdin was read and held nothing. Distinct from a read that failed, which is `1`. */
export const EMPTY_STDIN = 3;
/** A required section is missing, out of order, or empty. `report file` only. */
export const BAD_SECTIONS = 4;
/** The body carries a machine-local path and `--redact` was not given. */
export const LEAKED_PATH = 5;
/**
 * The body is a bare `@` path reference — **not** redactable.
 *
 * Separate from {@link LEAKED_PATH} because the fixes are opposite: the caller's loop on a path
 * refusal is *re-run with `--redact`*, and on a body that IS a path that loop never terminates.
 */
export const BARE_AT_PATH = 6;
/** The write target does not exist: `--label` in the repo, or `--issue`. */
export const NO_TARGET = 7;
/**
 * The write itself failed, so the outcome is **UNKNOWN** — deliberately not `1`.
 *
 * A create or comment call that times out may or may not have landed. Seating that on `1` would
 * make "GitHub refused the write" indistinguishable from "the binary is broken", which is the
 * verdict-versus-invocation collision the reserved range exists to prevent (#4208, #4219).
 */
export const WRITE_UNKNOWN = 8;
/** The write landed but the read-back does not match. The artifact exists and needs a human. */
export const READBACK_MISMATCH = 9;
/** The title or `--label` carries a type or priority classification. `report file` only. */
export const CLASSIFIED = 10;
/**
 * A precondition read failed, so nothing was written and no outcome is proven.
 *
 * Allocated its own code rather than folded into an existing one (#4752's class): the label-set
 * read is what makes {@link NO_TARGET} and {@link CLASSIFIED} *proven*, so a failed read of it can
 * be neither. It is not `8` — nothing was attempted — and not `1`, which would fuse an unreachable
 * GitHub with a bad flag.
 */
export const PRECONDITION_UNKNOWN = 11;
/**
 * The intake queue could not be read, so the outcome is UNKNOWN. `report dedup` only.
 *
 * Seated here rather than in `dedup-verb.ts`, where it sat on `3` and meant a second thing the group
 * already spoke for (#5296). The number is the jump it looks like: `12`-`26` are densely allocated as
 * *private* codes by the groups that align to this table, and a base seat inside that range reds
 * every group holding it — so `27` is the lowest number that collides with nothing. The band beyond
 * is not reserved; the alignment check is what keeps a later group off these two.
 */
export const QUEUE_UNREADABLE = 27;
/** The search index could not be read, so the outcome is UNKNOWN. `report dedup` only. */
export const SEARCH_UNREADABLE = 28;
