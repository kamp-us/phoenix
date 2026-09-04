/**
 * Atomic groups: the unit the transcript bounds are allowed to cut on.
 *
 * A prompt, the assistant turn it produced and the tool items between them read as one exchange,
 * so a bound that kept half of one would render a tool call whose call never appears. Grouping is
 * a pure fold over the item union — model-blind, and the only shape both bounds below reason about.
 */

import {byteLength, type TranscriptItem} from "../ports/index.ts";

export type NonEmpty<A> = readonly [A, ...Array<A>];

export interface TranscriptGroup {
	readonly items: NonEmpty<TranscriptItem>;
	readonly bytes: number;
	/** Index of the group's first item in the slice it was folded from, oldest-first. */
	readonly start: number;
}

/** One item's weight against the byte bound: its wire form, which is what a transport pays for. */
export const itemBytes = (item: TranscriptItem): number => byteLength(JSON.stringify(item));

export const groupBytes = (items: ReadonlyArray<TranscriptItem>): number =>
	items.reduce((total, item) => total + itemBytes(item), 0);

/**
 * Fold an oldest-first slice into atomic groups.
 *
 * A `user` item opens a group and absorbs the `assistant` and `tool` items that follow it; a
 * `system` item is session-level and stands alone; an `assistant` or `tool` item with no prompt
 * before it opens an orphan group of its own, so a slice starting mid-exchange still groups.
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
		groups.push({items: members, bytes: groupBytes(members), start: open.start});
		open = null;
	};
	items.forEach((item, index) => {
		if (item.kind === "system") {
			close();
			groups.push({items: [item], bytes: itemBytes(item), start: index});
			return;
		}
		if (item.kind === "user" || open === null) {
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
