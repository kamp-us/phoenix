/**
 * Minting the `recency` stamp every window and process row carries (#7627, founder ruling A of
 * 2026-09-03).
 *
 * The stamp is one counter over the whole desk rather than a per-window one, so two stamps from
 * different windows are comparable: the highest stamp on the snapshot is the thing focused or
 * spawned last. `nextRecency` reads that maximum off the snapshot rather than holding a cell, which
 * keeps the rule a pure function of the state it stamps — the same reason `applyPatch` lives beside
 * the schema it decodes rather than inside a service.
 *
 * No shell holds windows yet (#7499), so `focusWindow` has no production caller; it is here so the
 * shell that lands next stamps the field the protocol declares instead of inventing its own rule.
 */

import type {Recency, WindowId} from "./ids.ts";
import {Snapshot} from "./messages.ts";

/** The first stamp on a fresh desk. Zero is left free so "never touched" stays expressible. */
export const FIRST_RECENCY: Recency = 1;

const MAX_RECENCY = 0xffffffff;

/**
 * One past the highest stamp the snapshot carries. It saturates rather than wrapping: `Recency` is
 * a uint32, and a desk that reached four billion focus changes is better served by a frozen order
 * than by a counter that suddenly ranks the oldest window first.
 */
export const nextRecency = (snapshot: Snapshot): Recency => {
	let highest = 0;
	for (const window of Object.values(snapshot.windows)) {
		if (window.recency > highest) highest = window.recency;
	}
	for (const row of snapshot.processes) {
		if (row.recency > highest) highest = row.recency;
	}
	return Math.min(highest + 1, MAX_RECENCY) as Recency;
};

/** The snapshot with `window` stamped as the most recently focused. An unknown id changes nothing. */
export const focusWindow = (snapshot: Snapshot, window: WindowId): Snapshot => {
	const current = snapshot.windows[window];
	if (current === undefined) return snapshot;
	return new Snapshot({
		...snapshot,
		windows: {...snapshot.windows, [window]: {...current, recency: nextRecency(snapshot)}},
	});
};
