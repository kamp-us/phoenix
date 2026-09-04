/**
 * The bounded live-tail window: the newest whole exchanges that fit under both bounds, plus what
 * the bounds left out.
 *
 * Founder ruling 2026-09-02 (#7569): the window is the live tail only — older history is paged
 * through `planTranscriptPage`, never accumulated here. Re-derived by hand from the frozen POC
 * `packages/tuval/src/backend/coding-agent-transcript.ts` on `epic/7140`, which planned the same
 * two bounds over Pi's own transcript type; this one is model-blind and refuses instead of throwing.
 */

import type {TranscriptItem, TranscriptPayload, WindowOmission} from "../ports/index.ts";
import {groupTranscript, itemBytes, locateCursor, type TranscriptGroup} from "./groups.ts";
import type {PlanRefusal} from "./refusal.ts";

/** How many items the live tail may carry. */
export const TRANSCRIPT_WINDOW_ITEM_LIMIT = 40;

/** How many bytes of wire form the live tail may carry. */
export const TRANSCRIPT_WINDOW_BYTE_LIMIT = 256_000;

export interface TranscriptWindow extends TranscriptPayload {
	readonly kind: "window";
	/** Index of the window's oldest item in the slice it was planned over, oldest-first. */
	readonly start: number;
}

export type TranscriptWindowResult = TranscriptWindow | PlanRefusal;

export interface WindowOptions {
	/**
	 * The id of the item the window ends just older than, or `null` for the newest end. It must
	 * open an atomic group: any other id would end the window mid-exchange, which is a refusal.
	 */
	readonly before?: string | null;
	readonly itemLimit?: number;
	readonly byteLimit?: number;
}

/** Which bound refuses this group here, in the vocabulary `WindowOmission` speaks. */
export const stoppedBy = (
	group: TranscriptGroup,
	taken: {readonly items: number; readonly bytes: number},
	limits: {readonly items: number; readonly bytes: number},
): WindowOmission["reason"] | null => {
	if (taken.items + group.items.length > limits.items) return "item-limit";
	if (taken.bytes + group.bytes > limits.bytes) return "byte-limit";
	return null;
};

export const positiveLimit = (limit: number): PlanRefusal | null =>
	Number.isInteger(limit) && limit > 0
		? null
		: {kind: "refused", reason: "limit-not-positive", limit};

/**
 * Resolve an exclusive `before` cursor to a group index, refusing an id that is absent or that
 * sits inside a group rather than opening one.
 */
export const boundaryOf = (
	history: ReadonlyArray<TranscriptItem>,
	groups: ReadonlyArray<TranscriptGroup>,
	cursor: string | null,
): number | PlanRefusal => {
	if (cursor === null) return groups.length;
	const position = locateCursor(history, groups, cursor);
	if (position.kind === "absent") return {kind: "refused", reason: "cursor-not-found", cursor};
	if (position.kind === "splits-group") {
		return {kind: "refused", reason: "cursor-splits-group", cursor};
	}
	return position.group;
};

/** The item index a group boundary sits at, so an empty answer still names where it ended. */
export const itemIndexOf = (
	history: ReadonlyArray<TranscriptItem>,
	groups: ReadonlyArray<TranscriptGroup>,
	boundary: number,
): number => groups[boundary]?.start ?? history.length;

export const bytesOf = (items: ReadonlyArray<TranscriptItem>): number =>
	items.reduce((total, item) => total + itemBytes(item), 0);

export const planTranscriptWindow = (
	history: ReadonlyArray<TranscriptItem>,
	options: WindowOptions = {},
): TranscriptWindowResult => {
	const itemLimit = options.itemLimit ?? TRANSCRIPT_WINDOW_ITEM_LIMIT;
	const byteLimit = options.byteLimit ?? TRANSCRIPT_WINDOW_BYTE_LIMIT;
	const badLimit = positiveLimit(itemLimit) ?? positiveLimit(byteLimit);
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
		const stop = stoppedBy(group, {items, bytes}, {items: itemLimit, bytes: byteLimit});
		if (stop !== null) {
			reason = stop;
			break;
		}
		taken.unshift(group);
		items += group.items.length;
		bytes += group.bytes;
	}

	const start = taken[0]?.start ?? itemIndexOf(history, groups, boundary);
	const dropped = history.slice(0, start);
	return {
		kind: "window",
		start,
		items: taken.flatMap((group) => [...group.items]),
		omitted: {items: dropped.length, bytes: bytesOf(dropped), reason},
	};
};
