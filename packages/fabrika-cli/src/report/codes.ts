/**
 * The one exit table the `report` verbs allocate from.
 *
 * The shared band below is **re-exported from `../exit-codes.ts`, not defined here** — report
 * wrote these numbers first, which is exactly why it no longer owns them: a table one group authored
 * was a constitution every other group had to import secondhand, and this group's own verbs read
 * their shared seats through the same registry everyone else does. What remains here is the group's
 * private band and its reasoning.
 *
 * `0`, `1` and `127` are the interface convention's reserved codes (see `../verb.ts`); everything
 * re-exported here is `3` and up, the band a verb owns for outcomes it PROVED.
 */

export {
	BAD_SECTIONS,
	BARE_AT_PATH,
	CLASSIFIED,
	EMPTY_STDIN,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "../exit-codes.ts";

/**
 * The intake queue could not be read, so the outcome is UNKNOWN. `report dedup` only.
 *
 * Seated here rather than in `dedup-verb.ts`, where it sat on `3` and meant a second thing the group
 * already spoke for (#5296). The number is the jump it looks like: `12`-`26` are densely allocated as
 * *private* codes by the groups that align to the shared band, and a base seat inside that range reds
 * every group holding it — so `27` is the lowest number that collides with nothing. The band beyond
 * is not reserved; the alignment check is what keeps a later group off these two.
 */
export const QUEUE_UNREADABLE = 27;
/** The search index could not be read, so the outcome is UNKNOWN. `report dedup` only. */
export const SEARCH_UNREADABLE = 28;
