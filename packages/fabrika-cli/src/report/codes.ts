/**
 * Exit allocations for `report`; caller semantics are in `./command.ts` help.
 * Shared meanings are re-exported from `../exit-codes.ts`. They no longer belong to report,
 * so every group imports the registry directly instead of taking a secondhand copy.
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
 * already spoke for. The number is the jump it looks like: `12`-`26` are densely allocated as
 * *private* codes by the groups that align to the shared band, and a base seat inside that range reds
 * every group holding it — so `27` is the lowest number that collides with nothing. The band beyond
 * is not reserved; the alignment check is what keeps a later group off these two.
 */
export const QUEUE_UNREADABLE = 27;
export const SEARCH_UNREADABLE = 28;
