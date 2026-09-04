/**
 * The page bound: one older slice of history at a time, whole exchanges only, with the cursor for
 * the page older than it.
 *
 * History is backend-owned (#7569) — this is a pure bound over a slice the backend already
 * returned, never a store. Paging walks older, so a page carries its items oldest-first and its
 * `next` cursor names its own oldest item: the id the caller sends back as `before`. `next` is
 * `null` exactly when the supplied slice holds nothing older — whether the backend does is the
 * adapter's question, not this bound's.
 */

import type {TranscriptItem, TranscriptPagePayload, WindowOmission} from "../ports/index.ts";
import {groupTranscript, type TranscriptGroup} from "./groups.ts";
import type {PlanRefusal} from "./refusal.ts";
import {
	boundaryOf,
	bytesOf,
	itemIndexOf,
	positiveLimit,
	stoppedBy,
	TRANSCRIPT_WINDOW_BYTE_LIMIT,
} from "./window.ts";

export type TranscriptPage = Extract<TranscriptPagePayload, {kind: "page"}> & {
	/** Index of the page's oldest item in the slice it was planned over, oldest-first. */
	readonly start: number;
};

export type TranscriptPageResult = TranscriptPage | PlanRefusal;

export interface PageOptions {
	/** The oldest item the caller already holds, or `null` to start at the newest end. */
	readonly before?: string | null;
	readonly limit: number;
	readonly byteLimit?: number;
}

/**
 * Plan the page immediately older than `before`.
 *
 * The limits round up to a whole group: a single exchange larger than `limit` is emitted whole
 * rather than split, because a page that could not carry it would return nothing and leave every
 * older item unreachable. The window's bounds are the hard ones; this one keeps history walkable.
 */
export const planTranscriptPage = (
	history: ReadonlyArray<TranscriptItem>,
	options: PageOptions,
): TranscriptPageResult => {
	const byteLimit = options.byteLimit ?? TRANSCRIPT_WINDOW_BYTE_LIMIT;
	const badLimit = positiveLimit(options.limit) ?? positiveLimit(byteLimit);
	if (badLimit !== null) return badLimit;

	const groups = groupTranscript(history);
	const boundary = boundaryOf(history, groups, options.before ?? null);
	if (typeof boundary !== "number") return boundary;

	const taken: Array<TranscriptGroup> = [];
	let items = 0;
	let bytes = 0;
	let reason: WindowOmission["reason"] = "none";
	for (let index = boundary - 1; index >= 0; index -= 1) {
		const group = groups[index];
		if (group === undefined) break;
		const stop = stoppedBy(group, {items, bytes}, {items: options.limit, bytes: byteLimit});
		if (stop !== null && taken.length > 0) {
			reason = stop;
			break;
		}
		taken.unshift(group);
		items += group.items.length;
		bytes += group.bytes;
	}

	const start = taken[0]?.start ?? itemIndexOf(history, groups, boundary);
	const older = history.slice(0, start);
	const pageItems = taken.flatMap((group) => [...group.items]);
	return {
		kind: "page",
		start,
		items: pageItems,
		omitted: {items: older.length, bytes: bytesOf(older), reason},
		next: older.length === 0 ? null : (pageItems[0]?.id ?? null),
	};
};
