/**
 * The one exit table every `adr` verb allocates from, so a code means one thing across the group.
 *
 * Before this table each verb seated its own numerals and the group collided with itself: `3` was
 * `ALREADY_EXISTS`, `BASE_UNFETCHABLE`, `NO_SUBJECT` or `CORPUS_UNREADABLE` depending on which verb
 * produced it, and `NO_SUBJECT` was `3` under `adr supersede` and `4` under `adr sweep` — one name,
 * two numbers, shipped (#5294).
 *
 * The two shared seats are **imported from the base, never re-typed** — the discipline
 * `../exit-code-alignment.ts` can check, because an import cannot drift. `12` and up are this
 * group's own.
 *
 * **`5` is absent from this table on purpose and must not be added to it.** It meant "the record
 * directory was read and is empty — refusing" until #5254 and #5297 made that state an answer, so it
 * is a *vacated* seat rather than a free one: a caller still pinned to the old reading would take a
 * new meaning there as the old one. The private band starting at `12` puts it out of reach.
 *
 * `0`, `1` and `127` are reserved by the interface convention (`../verb.ts`). A malformed `<id>` or
 * `<slug>` stays on `1` with the other usage errors: `adr resolve` already refuses a non-four-digit
 * id there, so `adr new`'s old `BAD_ARGUMENT = 4` put one fact on two numbers at the reserved end of
 * the same table.
 */

import {
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
} from "../report/codes.ts";

/**
 * The record the caller named is not there: `<id>` under `--dir`, or `--new`'s id or path.
 *
 * The base's target seat, and the same fact — the thing the verb was pointed at does not exist. One
 * seat for `adr supersede`'s subject and `adr sweep`'s `--new` is the collision this table was
 * written to end.
 */
export const NO_SUBJECT = REPORT_NO_TARGET;

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
export const DIR_UNREADABLE = REPORT_PRECONDITION_UNKNOWN;

/** The target path already exists — refused, never overwritten. */
export const ALREADY_EXISTS = 12;
/** `--by` has no record under `--dir` — the link would be dead on arrival. */
export const NO_BY = 13;
/** `<id>`'s frontmatter has no single rewritable `status:` line. */
export const NO_STATUS_LINE = 14;
/** The rewrite would have changed a line other than `status:` — aborted before writing. */
export const MULTI_LINE_DIFF = 15;
/** `<id>` is already `superseded by …`, so it is not amendable or re-supersedable. */
export const ALREADY_SUPERSEDED = 16;
/** `--base` could not be fetched, so the merged set is UNKNOWN. */
export const BASE_UNFETCHABLE = 17;
/** The open pull requests could not be enumerated, so the in-flight set is UNKNOWN. */
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
 * not an empty directory, and #5254/#5297 already made "read and empty" an answer rather than a
 * refusal.
 */
export const CORPUS_DECLINED = 22;
