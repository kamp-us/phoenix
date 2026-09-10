/**
 * Exit allocations for `adr`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts` so separate verbs cannot assign competing numbers.
 *
 * Code 5 is retired. It refused an empty directory before that became a valid answer.
 * Reusing it would give old callers a different meaning for the same number.
 */

import {
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
} from "../exit-codes.ts";

/**
 * The record the caller named is not there: `<id>` under `--dir`, or `--new`'s id or path.
 *
 * The base's target seat, and the same fact — the thing the verb was pointed at does not exist. One
 * seat for `adr supersede`'s subject and `adr sweep`'s `--new` is the collision this table was
 * written to end.
 */
export const NO_SUBJECT = SHARED_NO_TARGET;

/**
 * The record directory could not be read in full, so every answer over it is UNKNOWN.
 *
 * One seat for `adr next`/`adr resolve`'s `--dir` at the fetched base ref and for `adr sweep`'s
 * corpus — a listing that failed and a member that could not be read are the same fact to a caller,
 * whose remedy is the directory either way.
 *
 * The base's precondition seat, for the base's own reason: reading the directory is what makes
 * {@link NO_SUBJECT} *proven*, so a failed read of it can never be that. The other two UNKNOWN reads
 * below keep their own codes because they read something else — a git ref, GitHub's open pull
 * requests — and neither is the precondition of a seat in this table.
 */
export const DIR_UNREADABLE = SHARED_PRECONDITION_UNKNOWN;

export const ALREADY_EXISTS = 12;
export const NO_BY = 13;
export const NO_STATUS_LINE = 14;
export const MULTI_LINE_DIFF = 15;
export const ALREADY_SUPERSEDED = 16;
export const BASE_UNFETCHABLE = 17;
export const IN_FLIGHT_UNKNOWN = 18;

/**
 * A record under `--dir` has a filename this group cannot read an id from.
 *
 * One seat for `adr next` and `adr resolve` on {@link DIR_UNREADABLE}'s precedent: both say the same
 * thing about the same directory, and the caller's remedy is the filename either way. A seat per verb
 * would make the remedy look like it depended on which verb happened to find it.
 */
export const UNPARSEABLE_RECORD_ID = 19;

/**
 * Two records under `--dir` claim one id, so every answer over that id would be arbitrary.
 *
 * `adr resolve` proves this at two call sites — over the whole listing, and again over the records it
 * read statuses for — and they are one fact, so they share the seat.
 */
export const DUPLICATE_ID = 20;

/**
 * `--repo` was not given and the `origin` remote could not be read, so the in-flight set is UNKNOWN.
 *
 * Its own seat rather than {@link DIR_UNREADABLE}'s for that seat's own stated reason: this reads
 * something else — the git remote — and it is the precondition of the in-flight half, not of the
 * record directory. Not `1`, which would fuse a missing remote with a bad flag.
 */
export const ORIGIN_REPO_UNRESOLVABLE = 21;

/**
 * `.fabrika.jsonc` declines `decisionsDir`: this repo keeps no decision corpus, so there is nothing
 * to read and nothing to write into.
 *
 * Its own seat rather than {@link DIR_UNREADABLE}'s, because the two are opposites a caller must
 * route differently: `11` is "nobody could read the corpus", UNKNOWN and worth retrying, while this
 * is a settled fact about the repo that no retry changes. Not `7`-shaped either — a declined key is
 * not an empty directory, and "read and empty" is already an answer rather than a refusal.
 */
export const CORPUS_DECLINED = 22;
