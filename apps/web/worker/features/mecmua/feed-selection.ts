/**
 * The subscribed-author feed's pure selection decision (#2500) — DB-free, so the
 * two load-bearing feed ACs are unit-provable with no SQL engine (ADR 0082, the
 * `src/lib/panoFeedSort.ts` role): given a candidate row set and the reader's
 * subscribed author ids, keep only the PUBLISHED posts authored by a subscribed
 * author and order them newest-published-first (`publishedAt desc, id desc`).
 *
 * `Mecmua.listFeedConnection` runs this over the rows its keyset SQL fetched, so the
 * feed's published-mask + ordering are enforced HERE (in JS), the same guarantee the
 * SQL `WHERE`/`ORDER BY` (derived from `MecmuaPostVisibility` + `MECMUA_FEED_ORDERING`)
 * mirror. Draft exclusion reuses `mecmuaPostVisibleTo` against the anonymous viewer —
 * a null `publishedAt` (draft) is masked from the feed for everyone, its author
 * included (the feed is a reading surface, not a drafts list).
 */
import {anonymousMecmuaViewer, mecmuaPostVisibleTo} from "./MecmuaPostVisibility.ts";
import type {MecmuaPostRow} from "./post-fields.ts";

/**
 * Select the subscribed-author feed from `rows`: published posts whose author is in
 * `subscribedAuthorIds`, newest-published first (ties broken by descending `id`).
 * Pure and total — no DB, no clock.
 */
export const selectMecmuaFeed = (
	rows: ReadonlyArray<MecmuaPostRow>,
	subscribedAuthorIds: ReadonlySet<string>,
): MecmuaPostRow[] =>
	rows
		.filter(
			(row) =>
				subscribedAuthorIds.has(row.authorId) &&
				// The published mask — a draft (null `publishedAt`) never appears in the feed,
				// reusing the same decision the public read applies (`MecmuaPostVisibility`).
				mecmuaPostVisibleTo(row.publishedAt, row.authorId, anonymousMecmuaViewer),
		)
		.sort(compareFeedRows);

/**
 * The `publishedAt desc, id desc` comparator — the JS mirror of `MECMUA_FEED_ORDERING`.
 * A filtered feed row always has a non-null `publishedAt` (the mask dropped the drafts),
 * so the `?? 0` fallbacks are unreachable defense, never a live branch.
 */
const compareFeedRows = (a: MecmuaPostRow, b: MecmuaPostRow): number => {
	const at = a.publishedAt?.getTime() ?? 0;
	const bt = b.publishedAt?.getTime() ?? 0;
	if (at !== bt) return bt - at;
	return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};
