/**
 * The one exit table all three `campaign` verbs allocate from
 * (`claude-plugins/fabrika/skills/campaign/contract.md`).
 *
 * Four seats are the base's and are **imported, never restated as numerals**, so a drift is
 * unrepresentable. `3`, `4`, `5`, `6` and `10` are left unallocated — no verb here reads stdin,
 * composes a body, or classifies anything — and this group's private band is `12`-`22`.
 *
 * {@link WRITE_UNKNOWN} and {@link PRECONDITION_UNKNOWN} are two different facts and the split is
 * the point: `11` is *nothing was attempted*, `8` is *a write was attempted and `ROADMAP.md` may be
 * half-written*, and {@link READBACK_MISMATCH} is the third — the file is written, readable, and
 * does not say what the verb wrote.
 */

import {
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

/** Proven: the selector names no row on the table. `campaign state` only. */
export const NO_TARGET = SHARED_NO_TARGET;
/** The write to the roadmap file failed, so the file may be half-written — UNKNOWN. */
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
/** The write landed and the read-back does not match it. */
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/**
 * The roadmap file could not be read, so nothing was attempted — UNKNOWN.
 *
 * Also the seat for a located row that reads as three cells but does not edit as three: the
 * contract's trigger names the file read, and the half of the `8`/`11` split that carries the
 * operator's next move is *whether a write was attempted*, which on that arm it was not.
 */
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/** Proven: a data row under `## Campaigns` will not parse — the whole table is unreadable. */
export const TABLE_UNREADABLE = 12;
/**
 * The cited comment, a team membership or the author's permission could not be read, so authority is
 * UNKNOWN and nothing was written.
 *
 * Also the seat for a `campaignAuthors` that will not decode: the contract's `22` is the
 * *roadmapFile* seat, and a set nobody could read is authority nobody could resolve — not an empty
 * set, which is `17` and a different, proven fact.
 */
export const AUTHORITY_UNKNOWN = 13;
/** Proven: the cited comment's first line carries no `campaign-approve:` marker. */
export const NO_MARKER = 14;
/** Proven: the marker is malformed, names another milestone or state, or is in another repository. */
export const MARKER_UNBOUND = 15;
/** Proven: the cited comment's author is not in `campaignAuthors`. */
export const AUTHOR_UNDECLARED = 16;
/** Proven: `campaignAuthors` is empty or absent — nobody may declare in this repo. */
export const NOBODY_DECLARED = 17;
/** Proven: the selector names more than one row. `campaign state` only. */
export const AMBIGUOUS_SELECTOR = 18;
/** Proven: the table already holds a row for this campaign or this milestone. `campaign open` only. */
export const DUPLICATE_ROW = 19;
/** Proven: the row already holds the state `--to` names — nothing written. `campaign state` only. */
export const ALREADY_IN_STATE = 20;
/** Proven: the cited comment's author is below the `write` floor on this repository (ADR 0055). */
export const BELOW_WRITE_FLOOR = 21;
/** `.fabrika.jsonc` could not be read, or its `roadmapFile` will not decode — UNKNOWN. */
export const CONFIG_UNREADABLE = 22;
