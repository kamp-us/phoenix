/**
 * The bounded live-tail window: the newest whole exchanges that fit under both bounds, plus what
 * the bounds left out.
 *
 * Founder ruling 2026-09-02 (#7569): the window is the live tail only — older history is paged
 * through `planTranscriptPage`, never accumulated here. Re-derived by hand from the frozen POC
 * `packages/tuval/src/backend/coding-agent-transcript.ts` on `epic/7140`, which planned the same
 * two bounds over Pi's own transcript type; this one is model-blind and refuses instead of throwing.
 *
 * The newest group in range is the one exception to both bounds: it is carried whole even when it
 * alone exceeds them, the same clause `planTranscriptPage` carries. One agentic turn is one group,
 * so a turn of forty tool calls crosses the item bound on its own — and an empty tail is not a
 * refusal, so `foldItem` would commit it and the operator's live transcript would collapse to the
 * paging control with the tail unreachable from state (#8031). Exceeding a bound by one turn is
 * recoverable; losing the turn is not.
 */

import {
	isNestedItem,
	type TranscriptItem,
	type TranscriptPayload,
	type WindowOmission,
} from "../ports/index.ts";
import {
	type GroupWeight,
	groupTranscript,
	itemBytes,
	locateCursor,
	type TranscriptGroup,
	withoutNested,
} from "./groups.ts";
import type {PlanRefusal} from "./refusal.ts";

/** How many items the live tail may carry. */
export const TRANSCRIPT_WINDOW_ITEM_LIMIT = 40;

/** How many bytes of wire form the live tail may carry. */
export const TRANSCRIPT_WINDOW_BYTE_LIMIT = 256_000;

/**
 * How much more a bound may carry in nested workers' rows than in the agent's own.
 *
 * A worker's rows ride free of the item and byte bounds so a spawn cannot evict the operator's
 * turns (#8814), but free of those bounds is not free of every bound: with the subagent list off
 * `chatRows` renders them folded under their call, so no ceiling at all would mean an unbounded
 * rendered tail — the defect moved rather than fixed. Four is the room for several whole workers
 * beside a full window of the operator's own turns, which is what a spawn-heavy session needs and
 * where a tail stops being one.
 */
export const TRANSCRIPT_NESTED_ALLOWANCE = 4;

export const nestedLimitsFor = (limits: GroupWeight): GroupWeight => ({
	items: limits.items * TRANSCRIPT_NESTED_ALLOWANCE,
	bytes: limits.bytes * TRANSCRIPT_NESTED_ALLOWANCE,
});

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

/** Which bound refuses this much more here, in the vocabulary `WindowOmission` speaks. */
export const stoppedBy = (
	weight: GroupWeight,
	taken: GroupWeight,
	limits: GroupWeight,
): WindowOmission["reason"] | null => {
	if (taken.items + weight.items > limits.items) return "item-limit";
	if (taken.bytes + weight.bytes > limits.bytes) return "byte-limit";
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

/** The two ceilings a walk answers to: the agent's own rows, and the workers' rows riding along. */
export interface TakeLimits {
	readonly own: GroupWeight;
	readonly nested: GroupWeight;
}

/** What one walk kept, where it started, and what it put down on the way. */
export interface TakenGroups {
	readonly items: ReadonlyArray<TranscriptItem>;
	/** Index of the oldest taken group's first item in the slice, oldest-first. */
	readonly start: number;
	/** Nested rows the ceiling made this walk put down, still inside the range it covers. */
	readonly shed: ReadonlyArray<TranscriptItem>;
	readonly reason: WindowOmission["reason"];
}

/**
 * Walk older from `boundary`, taking whole groups until a ceiling refuses one.
 *
 * The one walk both bounds run, because the nested ceiling is the kind of rule that gets applied in
 * one copy of a loop and forgotten in the other — and the copy that forgets it is unbounded.
 *
 * A ceiling reached does not evict the group: it puts the group's nested passengers down and keeps
 * the agent's own rows, so a spawn can never cost the operator a turn (#8814) while the tail stays
 * bounded at both ceilings. Only a group that was all passengers ends the walk, having nothing left
 * to keep. The newest group in range is the exception to every one of these, carried whole: an
 * empty tail is not a refusal, so `foldItem` would commit it and the live transcript would collapse
 * (#8031).
 */
export const takeGroups = (
	history: ReadonlyArray<TranscriptItem>,
	groups: ReadonlyArray<TranscriptGroup>,
	boundary: number,
	limits: TakeLimits,
): TakenGroups => {
	const kept: Array<ReadonlyArray<TranscriptItem>> = [];
	const shed: Array<ReadonlyArray<TranscriptItem>> = [];
	let spent: GroupWeight = {items: 0, bytes: 0};
	let carried: GroupWeight = {items: 0, bytes: 0};
	let start = itemIndexOf(history, groups, boundary);
	let reason: WindowOmission["reason"] = "none";
	for (let index = boundary - 1; index >= 0; index -= 1) {
		const group = groups[index];
		if (group === undefined) break;
		const newest = kept.length === 0;
		const stop = stoppedBy(group.weight, spent, limits.own);
		if (stop !== null && !newest) {
			reason = stop;
			break;
		}
		const nestedStop = newest ? null : stoppedBy(group.nested, carried, limits.nested);
		const members = nestedStop === null ? group.items : withoutNested(group);
		if (members === null) {
			reason = nestedStop ?? reason;
			break;
		}
		if (nestedStop !== null && group.nested.items > 0) {
			shed.unshift(group.items.filter(isNestedItem));
			reason = nestedStop;
		}
		kept.unshift(members);
		spent = {items: spent.items + group.weight.items, bytes: spent.bytes + group.weight.bytes};
		if (nestedStop === null) {
			carried = {
				items: carried.items + group.nested.items,
				bytes: carried.bytes + group.nested.bytes,
			};
		}
		start = group.start;
	}
	return {items: kept.flat(), start, shed: shed.flat(), reason};
};

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

	const own: GroupWeight = {items: itemLimit, bytes: byteLimit};
	const taken = takeGroups(history, groups, boundary, {own, nested: nestedLimitsFor(own)});
	const dropped = history.slice(0, taken.start);
	return {
		kind: "window",
		start: taken.start,
		items: taken.items,
		omitted: {
			items: dropped.length + taken.shed.length,
			bytes: bytesOf(dropped) + bytesOf(taken.shed),
			reason: taken.reason,
		},
	};
};
