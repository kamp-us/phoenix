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
	anchorsCursor,
	type TranscriptItem,
	type TranscriptPayload,
	type WindowOmission,
} from "../ports/index.ts";
import {
	type GroupWeight,
	groupTranscript,
	isShedItem,
	itemBytes,
	locateCursor,
	type ShedClasses,
	type TranscriptGroup,
	withoutPassengers,
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

/**
 * What share of a bound the session's notices may spend.
 *
 * A notice costs nothing against the conversation's own bound (`weighGroup`), so it needs a ceiling
 * of its own or a run of them is an unbounded rendered tail — the same trade #8814 struck for a
 * worker's rows, in the other direction: a worker's rows are hidden behind a slot and get room to
 * spare, notices render inline and get a quarter. At the shipped bound that is ten notices, which
 * is more than `chatRows` shows expanded in one collapsed run and far under the forty that emptied
 * a window of its conversation (#9514).
 */
export const TRANSCRIPT_NOTICE_SHARE = 1 / 4;

export const noticeLimitsFor = (limits: GroupWeight): GroupWeight => ({
	items: Math.max(1, Math.floor(limits.items * TRANSCRIPT_NOTICE_SHARE)),
	bytes: Math.max(1, Math.floor(limits.bytes * TRANSCRIPT_NOTICE_SHARE)),
});

/** The live window's passenger ceilings, derived from the conversation's own bound. */
export const windowPassengersFor = (own: GroupWeight): Omit<TakeLimits, "own"> => ({
	nested: nestedLimitsFor(own),
	notices: noticeLimitsFor(own),
	anchor: "yield",
});

/**
 * A page's, which drop no notice: a hole here is history no later page can tile over.
 *
 * `anchor: "hold"` for the other half of the same reason. A page cursor is minted from the live
 * window, never from a page answer, so a page has no anchor to hold out for — and `planTranscriptPage`
 * runs this walk with `own.items` set to the caller's `limit`, so a walk that yielded its own bound
 * would answer more rows than were asked for.
 */
export const pagePassengersFor = (own: GroupWeight): Omit<TakeLimits, "own"> => ({
	nested: nestedLimitsFor(own),
	notices: "own",
	anchor: "hold",
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

const plusWeight = (left: GroupWeight, right: GroupWeight): GroupWeight => ({
	items: left.items + right.items,
	bytes: left.bytes + right.bytes,
});

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

/**
 * The ceilings a walk answers to: the conversation's own rows, a spawned worker's rows riding
 * along, what the session's notices answer to, and whether the own bound yields to the anchor rule.
 *
 * `notices: "own"` is the page walk's answer and means they are charged to the conversation's own
 * bound, exactly as they were before they had a bucket. A page tiles history one contiguous range at
 * a time, and a walk that puts a row down leaves a hole no later page covers — the row is gone from
 * the reader's history rather than deferred to it. Shedding is the live window's alone, where a
 * dropped notice costs nothing a reader could have gone back for: a notice is live-only (no backend
 * history read resolves one, per `anchorsCursor`) and `chatRows` collapses a whole run of them into
 * one rendered line.
 */
export interface TakeLimits {
	readonly own: GroupWeight;
	readonly nested: GroupWeight;
	readonly notices: GroupWeight | "own";
	/**
	 * `yield` lets the walk cross the own bound while it still holds no row a page cursor can be
	 * minted from; `hold` makes the bound absolute. Only the live window yields — it is the surface
	 * an unanchored answer strands, and the page walk's own bound *is* the caller's `limit`.
	 */
	readonly anchor: "yield" | "hold";
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
 * The one walk both bounds run, because a passenger ceiling is the kind of rule that gets applied
 * in one copy of a loop and forgotten in the other — and the copy that forgets it is unbounded.
 *
 * A ceiling reached does not evict the group: it puts that class of passenger down and keeps the
 * conversation's own rows, so neither a spawn (#8814) nor a run of notices (#9514) can cost the
 * operator a turn while the tail stays bounded at every ceiling. A group left with nothing but the
 * passengers a ceiling refused is stepped over rather than kept, and the walk goes on past it while
 * the window still holds no row a page cursor can be minted from.
 *
 * That last clause is the invariant the three reports of an unreadable window all reduce to: a
 * window whose every row fails `anchorsCursor` renders as one collapsed line and then refuses every
 * page off itself, so the operator can neither read the session nor walk back into it (#9514,
 * #8031, #8814). So under `anchor: "yield"` the own bound bends to it — but by one group, not
 * without limit: past the bound and still unanchored, the walk stops *keeping* groups and only
 * steps over them, until a group holding an anchor lands. That one is kept and ends the walk. So
 * the answer is at most the bound plus one group, the same overshoot the newest-group clause
 * already allows, rather than the whole history a tail that never anchors would otherwise drag in.
 * Under `anchor: "hold"` the bound is absolute and the walk simply ends there, which is what keeps
 * `planTranscriptPage` answering exactly the `limit` it was asked for.
 *
 * The newest group in range is still the exception to every ceiling, carried whole — an empty tail
 * is not a refusal, so `foldItem` would commit it and the live transcript would collapse (#8031).
 */
export const takeGroups = (
	history: ReadonlyArray<TranscriptItem>,
	groups: ReadonlyArray<TranscriptGroup>,
	boundary: number,
	limits: TakeLimits,
): TakenGroups => {
	const kept: Array<ReadonlyArray<TranscriptItem>> = [];
	const shed: Array<ReadonlyArray<TranscriptItem>> = [];
	const riding = limits.notices !== "own";
	let spent: GroupWeight = {items: 0, bytes: 0};
	let nested: GroupWeight = {items: 0, bytes: 0};
	let notices: GroupWeight = {items: 0, bytes: 0};
	let anchored = false;
	let start = itemIndexOf(history, groups, boundary);
	let reason: WindowOmission["reason"] = "none";
	for (let index = boundary - 1; index >= 0; index -= 1) {
		const group = groups[index];
		if (group === undefined) break;
		const newest = kept.length === 0;
		const own = riding ? group.weight : plusWeight(group.weight, group.notices);
		const stop = newest ? null : stoppedBy(own, spent, limits.own);
		// Past the own bound with no anchor yet, and a walk allowed to yield: this group is worth
		// crossing the bound for only if it can supply the anchor, and it is the last one either way.
		const seeking = stop !== null && limits.anchor === "yield" && !anchored;
		if (stop !== null && !seeking) {
			reason = stop;
			break;
		}
		if (seeking && !group.items.some(anchorsCursor)) {
			reason = stop ?? reason;
			shed.unshift(group.items);
			start = group.start;
			continue;
		}
		const nestedStop = newest ? null : stoppedBy(group.nested, nested, limits.nested);
		const noticeStop =
			newest || limits.notices === "own" ? null : stoppedBy(group.notices, notices, limits.notices);
		const shedding: ShedClasses = {nested: nestedStop !== null, notices: noticeStop !== null};
		const refused = nestedStop ?? noticeStop;
		const members = withoutPassengers(group, shedding);
		if (members === null) {
			reason = refused ?? reason;
			// Nothing of this group survived its ceilings, and which ceiling refused it decides
			// whether the walk ends. A worker's rows end it (#8814): they are the slot's, and the
			// operator's tail already has what it came for. A run of notices does not — the
			// conversation the bound exists to carry is behind it, and stopping here is how a window
			// that meant to stop notices evicting turns would have evicted them itself. Stepping
			// over puts the group down inside the range, so it is counted in `shed` and never again
			// by the drop.
			if (nestedStop !== null && anchored) break;
			shed.unshift(group.items);
			start = group.start;
			continue;
		}
		const putDown = group.items.filter((item) => isShedItem(item, shedding));
		if (putDown.length > 0) {
			shed.unshift(putDown);
			reason = refused ?? reason;
		}
		kept.unshift(members);
		spent = plusWeight(spent, own);
		if (!shedding.nested) nested = plusWeight(nested, group.nested);
		if (riding && !shedding.notices) notices = plusWeight(notices, group.notices);
		anchored = anchored || members.some(anchorsCursor);
		start = group.start;
		// The bound was already spent when this group was taken; it was taken for its anchor, and
		// the walk has what it crossed the bound for.
		if (seeking && stop !== null) {
			reason = stop;
			break;
		}
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
	const taken = takeGroups(history, groups, boundary, {own, ...windowPassengersFor(own)});
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
