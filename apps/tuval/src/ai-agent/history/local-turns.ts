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

const localTurnCounts = (tail: ReadonlyArray<TranscriptItem>): Map<string, number> => {
	const counts = new Map<string, number>();
	for (const item of tail) {
		if (item.kind === "user" && item.local === true) {
			counts.set(item.text, (counts.get(item.text) ?? 0) + 1);
		}
	}
	return counts;
};

/**
 * `page` minus the rows that are the store's copy of a turn `tail` already holds locally.
 *
 * Bounded by count and walked newest-first, because text alone is not identity. A prompt sent twice
 * leaves two local rows and drops two stored rows, so the two deliberate turns stay two. A turn
 * whose local row has already fallen out of the bounded tail keeps its stored row — past the tail
 * that row is the only place the operator's own words exist, and dropping it would hand back the
 * very defect this join exists to close.
 */
export const withoutLocalEchoes = (
	page: ReadonlyArray<TranscriptItem>,
	tail: ReadonlyArray<TranscriptItem>,
): ReadonlyArray<TranscriptItem> => {
	const budget = localTurnCounts(tail);
	if (budget.size === 0) return page;
	const dropped = new Set<number>();
	for (let index = page.length - 1; index >= 0; index -= 1) {
		const item = page[index];
		if (item === undefined || item.kind !== "user") continue;
		const left = budget.get(item.text) ?? 0;
		if (left === 0) continue;
		budget.set(item.text, left - 1);
		dropped.add(index);
	}
	return dropped.size === 0 ? page : page.filter((_, index) => !dropped.has(index));
};
