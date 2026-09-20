/**
 * Joining a page of stored history to the turns the core recorded locally.
 *
 * The core writes the operator's turn at the send, under an id derived from the send's own
 * idempotency key (`../core/fold.ts`, #7978). A backend that stores the conversation writes that
 * same turn under an id of its own — the Claude CLI's transcript does, and `getSessionMessages`
 * hands it straight back — so a reader holding both the live tail and a page over the same turn
 * holds two rows for it (#7979).
 *
 * No id joins those two: the key is Tuval's and never reaches the backend's store, and the layer
 * that held the send is rebuilt on every resume, so nothing survives a reconnect to re-key by. Text
 * is the join the core itself uses for a layer's echo, so it is the join here.
 */

import type {TranscriptItem} from "../ports/index.ts";

const localTurnsByText = (
	tail: ReadonlyArray<TranscriptItem>,
): Map<string, Array<TranscriptItem>> => {
	const rows = new Map<string, Array<TranscriptItem>>();
	for (const item of tail) {
		if (item.kind !== "user" || item.local !== true) continue;
		const held = rows.get(item.text);
		if (held === undefined) rows.set(item.text, [item]);
		else held.push(item);
	}
	return rows;
};

/**
 * Which `page` rows are the store's copy of a turn `tail` holds locally, by their index in `page`,
 * paired with the local row each one is a copy of.
 *
 * Bounded by count and walked newest-first, because text alone is not identity. A prompt sent twice
 * leaves two local rows and pairs two stored rows, so the two deliberate turns stay two. A turn
 * whose local row has already fallen out of the bounded tail pairs with nothing — past the tail its
 * stored row is the only place the operator's own words exist, and dropping it would hand back the
 * very defect this join exists to close.
 *
 * The pairing is the answer rather than the filtered list because its two callers want opposite
 * halves of it: the paging stitch drops the stored copy (`withoutLocalEchoes`), and the resume's
 * refill puts the local row *where the stored copy sat* (`../core/fold.ts`, #8855) — appending it
 * instead reorders the operator's own turns to the end of the tail.
 */
export const localEchoes = (
	page: ReadonlyArray<TranscriptItem>,
	tail: ReadonlyArray<TranscriptItem>,
): ReadonlyMap<number, TranscriptItem> => {
	const paired = new Map<number, TranscriptItem>();
	const rows = localTurnsByText(tail);
	if (rows.size === 0) return paired;
	for (let index = page.length - 1; index >= 0; index -= 1) {
		const item = page[index];
		if (item === undefined || item.kind !== "user") continue;
		const local = rows.get(item.text)?.pop();
		if (local === undefined) continue;
		paired.set(index, local);
	}
	return paired;
};

/** `page` minus the rows that are the store's copy of a turn `tail` already holds locally. */
export const withoutLocalEchoes = (
	page: ReadonlyArray<TranscriptItem>,
	tail: ReadonlyArray<TranscriptItem>,
): ReadonlyArray<TranscriptItem> => {
	const paired = localEchoes(page, tail);
	return paired.size === 0 ? page : page.filter((_, index) => !paired.has(index));
};
