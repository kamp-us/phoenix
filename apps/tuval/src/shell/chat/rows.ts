/**
 * What the virtualized list is a list *of*, and the pure joins that build it.
 *
 * The transcript a window shows is two things stitched together: the older pages this window walked
 * back through, and the live tail the session keeps in its own state (#7569). The stitch is pure and
 * lives here rather than in the component, because "one `page` request carries the oldest loaded id"
 * and "a page prepends without duplicating what the tail already holds" are decisions a test can
 * make without a DOM.
 *
 * The head row is one row, never two: the loading row *replaces* the omitted-count line while a page
 * is in flight, and both disappear at the beginning of history (founder ruling, 2026-09-02).
 */

import type {ItemId, TranscriptItem} from "../../ai-agent/ports/index.ts";

export type ChatRow =
	/** There is more history behind this point; `items` is what the live-tail bound already dropped. */
	| {readonly kind: "older"; readonly items: number}
	/** A `page` request is out. */
	| {readonly kind: "loading"}
	| {
			readonly kind: "item";
			readonly item: TranscriptItem;
			/**
			 * The rows folded directly under this one, in list order. Empty for everything but a group
			 * head. The ids rather than a count, so "the head says 14" and "14 rows appear" cannot
			 * disagree, and so the head's disclosure can name the rows it controls (#8027).
			 */
			readonly nestedIds: ReadonlyArray<ItemId>;
			/** This row ran inside another tool call — a subagent's, not the agent's own. */
			readonly nested: boolean;
			/** How many folds deep this row sits. Zero for a row the agent itself opened. */
			readonly depth: number;
	  };

export interface ChatRowsInput {
	/** Pages this window has walked back through, oldest-first. */
	readonly older: ReadonlyArray<TranscriptItem>;
	/** The session's live tail, oldest-first. */
	readonly tail: ReadonlyArray<TranscriptItem>;
	/** How many items the live-tail bound dropped, off `transcript.omitted`. */
	readonly omitted: number;
	readonly loading: boolean;
	readonly atOldest: boolean;
	/** The ids of the group heads whose folded rows are showing, off this window's own view slot. */
	readonly unfolded?: ReadonlySet<string>;
}

/**
 * A stable key per row, so the virtualizer's measurement cache survives a prepend. Item rows key on
 * the item's own id — which is stable across an update, since a tool result re-sends the same id
 * with a new status (ruling 1, #7570) — and the two head rows key on their kind, of which at most
 * one is ever present.
 */
export const rowKey = (row: ChatRow): string =>
	row.kind === "item" ? `item:${row.item.id}` : row.kind;

/** Prepend a page, dropping anything the window already holds. Oldest-first, in and out. */
export const mergeOlder = (
	held: ReadonlyArray<TranscriptItem>,
	page: ReadonlyArray<TranscriptItem>,
): ReadonlyArray<TranscriptItem> => {
	const known = new Set(held.map((item) => item.id));
	const fresh = page.filter((item) => !known.has(item.id));
	return fresh.length === 0 ? held : [...fresh, ...held];
};

/** The call a tool row ran inside, when the backend marked one. Nothing else nests. */
const parentOf = (item: TranscriptItem): ItemId | undefined =>
	item.kind === "tool" ? item.parentId : undefined;

/**
 * The list the window renders. The tail wins on a collision: an item that reached the live stream is
 * the newer copy of itself, and a page that happens to overlap the tail must not double it.
 *
 * A tool row naming a parent that is also in this list is **folded under it** (founder ruling,
 * 2026-09-05): the group head carries the count and the folded rows appear only while it is
 * unfolded, which is what keeps a fifty-call subagent from flooding the window. A row whose parent
 * is not in the list — its group head is older than the pages walked back to — stays where it is,
 * marked nested, because dropping it would hide work that happened.
 *
 * The walk is depth-first, which is what makes that last sentence true of *every* shape the backend
 * can mark rather than only of a one-level fold: a subagent that spawns a subagent gives a folded
 * row children of its own, counted and rendered like any other head.
 *
 * `reachable` is walked separately from the render because the two ask different questions. A row
 * behind a folded head is hidden on purpose and must stay hidden; a row whose parent chain loops
 * back on itself belongs to no head at all and would otherwise vanish. Only the second is swept in
 * at the end, so no marked row is dropped and none is un-hidden.
 */
export const chatRows = (input: ChatRowsInput): ReadonlyArray<ChatRow> => {
	const inTail = new Set(input.tail.map((item) => item.id));
	const items = [...input.older.filter((item) => !inTail.has(item.id)), ...input.tail];
	const unfolded = input.unfolded ?? new Set<string>();
	const present = new Set(items.map((item) => item.id));
	const folded = new Map<string, Array<TranscriptItem>>();
	for (const item of items) {
		const parent = parentOf(item);
		if (parent === undefined || !present.has(parent)) continue;
		const group = folded.get(parent);
		if (group === undefined) folded.set(parent, [item]);
		else group.push(item);
	}
	const rows: Array<ChatRow> = [];
	if (!input.atOldest && items.length > 0) {
		rows.push(input.loading ? {kind: "loading"} : {kind: "older", items: input.omitted});
	}
	const roots = items.filter((item) => {
		const parent = parentOf(item);
		return parent === undefined || !present.has(parent);
	});
	const reachable = new Set<string>();
	const mark = (item: TranscriptItem): void => {
		if (reachable.has(item.id)) return;
		reachable.add(item.id);
		for (const child of folded.get(item.id) ?? []) mark(child);
	};
	for (const item of roots) mark(item);
	const seen = new Set<string>();
	const emit = (item: TranscriptItem, depth: number): void => {
		if (seen.has(item.id)) return;
		seen.add(item.id);
		const group = folded.get(item.id) ?? [];
		rows.push({
			kind: "item",
			item,
			nestedIds: group.map((child) => child.id),
			nested: depth > 0,
			depth,
		});
		if (!unfolded.has(item.id)) return;
		for (const child of group) emit(child, depth + 1);
	};
	for (const item of roots) emit(item, parentOf(item) === undefined ? 0 : 1);
	for (const item of items) {
		if (!reachable.has(item.id)) emit(item, 1);
	}
	return rows;
};

/** The `before` cursor for the next page: the oldest item the window currently holds. */
export const oldestLoadedId = (rows: ReadonlyArray<ChatRow>): string | null => {
	for (const row of rows) {
		if (row.kind === "item") return row.item.id;
	}
	return null;
};

/** Where the row carrying `id` sits, or `-1`. The anchor a prepend restores the viewport onto. */
export const rowIndexOfItem = (rows: ReadonlyArray<ChatRow>, id: string | null): number =>
	id === null ? -1 : rows.findIndex((row) => row.kind === "item" && row.item.id === id);
