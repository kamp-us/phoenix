/**
 * Atomic groups: the unit the transcript bounds are allowed to cut on.
 *
 * A prompt, the assistant turn it produced and the tool items between them read as one exchange,
 * so a bound that kept half of one would render a tool call whose call never appears. Grouping is
 * a pure fold over the item union — model-blind, and the only shape both bounds below reason about.
 */

import {byteLength, isNestedItem, type TranscriptItem} from "../ports/index.ts";

export type NonEmpty<A> = readonly [A, ...Array<A>];

/** What one group spends against the bounds: item count and wire bytes, as `stoppedBy` reads them. */
export interface GroupWeight {
	readonly items: number;
	readonly bytes: number;
}

export interface TranscriptGroup {
	readonly items: NonEmpty<TranscriptItem>;
	readonly bytes: number;
	/** Index of the group's first item in the slice it was folded from, oldest-first. */
	readonly start: number;
	/**
	 * What this group weighs against the bounds: its own rows, never the nested worker's rows riding
	 * with them. A subagent's rows are carried by its slot and hidden from the transcript
	 * (`shell/chat/rows.ts`), so charging the bounds for them evicts the operator's own turns to
	 * make room for rows nothing renders — a few spawns and the visible tail is empty (#8814). They
	 * still travel in `items`, because a window with the subagent list off folds them under the call
	 * that spawned them.
	 */
	readonly weight: GroupWeight;
}

/** One item's weight against the byte bound: its wire form, which is what a transport pays for. */
export const itemBytes = (item: TranscriptItem): number => byteLength(JSON.stringify(item));

export const groupBytes = (items: ReadonlyArray<TranscriptItem>): number =>
	items.reduce((total, item) => total + itemBytes(item), 0);

export const groupWeight = (items: ReadonlyArray<TranscriptItem>): GroupWeight => {
	const own = items.filter((item) => !isNestedItem(item));
	return {items: own.length, bytes: groupBytes(own)};
};

/**
 * Fold an oldest-first slice into atomic groups.
 *
 * A `user` item opens a group and absorbs the `assistant`, `thinking` and `tool` items that follow
 * it; a `system` or `compaction` item is session-level and stands alone; any turn item with no
 * prompt before it opens an orphan group of its own, so a slice starting mid-exchange still groups.
 *
 * A compaction marker stands alone for the same reason a system notice does, and for one more: it
 * is exactly the place a reader wants a bound to cut, so folding it into the turn beside it would
 * make the one boundary that explains missing history uncuttable.
 *
 * A nested worker's row is none of those things: it neither opens nor closes a group, so a
 * subagent's own prompt cannot split the operator's exchange in two and its notices cannot stand
 * between the operator's turn and the reply it produced (#8814).
 */
export const groupTranscript = (
	items: ReadonlyArray<TranscriptItem>,
): ReadonlyArray<TranscriptGroup> => {
	const groups: Array<TranscriptGroup> = [];
	// The head is held apart from the tail so the group's non-emptiness is a fact the compiler
	// carries, rather than an assertion over an array that happens never to be empty.
	let open: {head: TranscriptItem; tail: Array<TranscriptItem>; start: number} | null = null;
	const close = () => {
		if (open === null) return;
		const members: NonEmpty<TranscriptItem> = [open.head, ...open.tail];
		groups.push({
			items: members,
			bytes: groupBytes(members),
			start: open.start,
			weight: groupWeight(members),
		});
		open = null;
	};
	items.forEach((item, index) => {
		const nested = isNestedItem(item);
		if (!nested && (item.kind === "system" || item.kind === "compaction")) {
			close();
			groups.push({
				items: [item],
				bytes: itemBytes(item),
				start: index,
				weight: groupWeight([item]),
			});
			return;
		}
		if (open === null || (!nested && item.kind === "user")) {
			close();
			open = {head: item, tail: [], start: index};
			return;
		}
		open.tail.push(item);
	});
	close();
	return groups;
};

/** Where a cursor sits in a folded slice: at a group's oldest edge, inside one, or nowhere. */
export type CursorPosition =
	| {readonly kind: "found"; readonly group: number; readonly index: number}
	| {readonly kind: "splits-group"; readonly index: number}
	| {readonly kind: "absent"};

/**
 * Locate a cursor item by id. `found` carries the index of the group it opens, which is the only
 * position a bound may end on — an id landing anywhere else inside a group is `splits-group`.
 */
export const locateCursor = (
	items: ReadonlyArray<TranscriptItem>,
	groups: ReadonlyArray<TranscriptGroup>,
	cursor: string,
): CursorPosition => {
	const index = items.findIndex((item) => item.id === cursor);
	if (index < 0) return {kind: "absent"};
	const group = groups.findIndex((candidate) => candidate.start === index);
	return group < 0 ? {kind: "splits-group", index} : {kind: "found", group, index};
};
