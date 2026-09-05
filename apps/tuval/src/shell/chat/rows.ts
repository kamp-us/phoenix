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
			/** How many rows are folded under this one. Zero for everything but a group head. */
			readonly nestedCount: number;
			/** This row ran inside another tool call — a subagent's, not the agent's own. */
			readonly nested: boolean;
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
	/** The ids of the rows this window has expanded, off its own view slot. */
	readonly expanded?: ReadonlySet<string>;
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
 * expanded, which is what keeps a fifty-call subagent from flooding the window. A row whose parent
 * is not in the list — its group head is older than the pages walked back to — stays where it is,
 * marked nested, because dropping it would hide work that happened.
 */
export const chatRows = (input: ChatRowsInput): ReadonlyArray<ChatRow> => {
	const inTail = new Set(input.tail.map((item) => item.id));
	const items = [...input.older.filter((item) => !inTail.has(item.id)), ...input.tail];
	const expanded = input.expanded ?? new Set<string>();
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
	for (const item of items) {
		const parent = parentOf(item);
		if (parent !== undefined && present.has(parent)) continue;
		const group = folded.get(item.id) ?? [];
		rows.push({kind: "item", item, nestedCount: group.length, nested: parent !== undefined});
		if (!expanded.has(item.id)) continue;
		for (const child of group) rows.push({kind: "item", item: child, nestedCount: 0, nested: true});
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
