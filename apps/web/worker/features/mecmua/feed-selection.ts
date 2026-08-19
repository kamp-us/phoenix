/**
 * The subscribed-author feed's selection decision, kept DB-free so the feed's
 * published-mask and ordering are unit-provable with no SQL engine (ADR 0082). The
 * keyset SQL's `WHERE`/`ORDER BY` mirror this; this is the enforcing copy.
 *
 * A draft (null `publishedAt`) is masked from the feed for EVERYONE, its own author
 * included — the feed is a reading surface, not a drafts list.
 */
import {anonymousMecmuaViewer, mecmuaPostVisibleTo} from "./MecmuaPostVisibility.ts";
import type {MecmuaPostRow} from "./post-fields.ts";

export const selectMecmuaFeed = (
	rows: ReadonlyArray<MecmuaPostRow>,
	subscribedAuthorIds: ReadonlySet<string>,
): MecmuaPostRow[] =>
	rows
		.filter(
			(row) =>
				subscribedAuthorIds.has(row.authorId) &&
				mecmuaPostVisibleTo(row.publishedAt, row.authorId, anonymousMecmuaViewer),
		)
		.sort(compareFeedRows);

/**
 * The JS mirror of `MECMUA_FEED_ORDERING`. A filtered feed row always has a non-null
 * `publishedAt` (the mask dropped the drafts), so the `?? 0` fallbacks are
 * unreachable defense, never a live branch.
 */
const compareFeedRows = (a: MecmuaPostRow, b: MecmuaPostRow): number => {
	const at = a.publishedAt?.getTime() ?? 0;
	const bt = b.publishedAt?.getTime() ?? 0;
	if (at !== bt) return bt - at;
	return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};
