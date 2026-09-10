/**
 * The incremental half of the session stream: what one revision changed, and how a holder of the
 * previous whole value applies it.
 *
 * Both ends of the socket run this file. The server diffs the snapshot it is about to send against
 * the one it last sent and pushes `nextPush`'s answer; the client applies `applyDelta` to the
 * snapshot its lease holds. Keeping the two beside each other is what makes the round trip one
 * fact rather than two that have to be kept in step.
 *
 * A delta is a *change set over ids*, never a positional patch: the wire's transcript item id is
 * the message's own position (`../server/transcript.ts`), so an id that moves is a transcript that
 * was rewritten, and `nextPush` answers a whole snapshot for that rather than a delta nothing can
 * apply. The fallback is the invariant, not a heuristic — a delta is emitted only where the next
 * transcript extends the last one's id sequence as a prefix.
 */

import type {SessionDelta, SessionSnapshot} from "./session.ts";
import type {TranscriptItem} from "./transcript.ts";

/** What one revision is worth to a viewer that holds the previous one. */
export type SessionPush =
	| {readonly _tag: "Snapshot"; readonly snapshot: SessionSnapshot}
	| {readonly _tag: "Delta"; readonly delta: SessionDelta}
	/** The revision moved but nothing this viewer can see did, so there is nothing to send. */
	| {readonly _tag: "Unchanged"};

const sameItem = (left: TranscriptItem, right: TranscriptItem): boolean =>
	JSON.stringify(left) === JSON.stringify(right);

/**
 * Whether `next`'s transcript continues `last`'s rather than replacing it: same ids in the same
 * order for as far as `last` goes, and nothing dropped off the end. A compaction renumbers and a
 * branch replaces, and both land here as `false`.
 */
const extendsTranscript = (
	last: ReadonlyArray<TranscriptItem>,
	next: ReadonlyArray<TranscriptItem>,
): boolean => next.length >= last.length && last.every((item, at) => item.id === next[at]?.id);

const changedItems = (
	last: ReadonlyArray<TranscriptItem>,
	next: ReadonlyArray<TranscriptItem>,
): ReadonlyArray<TranscriptItem> =>
	next.filter((item, at) => {
		const before = last[at];
		return before === undefined || !sameItem(item, before);
	});

const sameSteer = (left: SessionSnapshot, right: SessionSnapshot): boolean =>
	left.queuedSteerCount === right.queuedSteerCount &&
	JSON.stringify(left.queuedSteer) === JSON.stringify(right.queuedSteer);

/**
 * The frame one revision is worth to a viewer holding `last` — absent for a viewer holding
 * nothing, which is its first subscribe and takes the whole value.
 *
 * A `name` that went away is the one scalar a delta cannot state: an absent key means unchanged,
 * so "no longer named" would be indistinguishable from it. That takes the whole value too.
 */
export const nextPush = (last: SessionSnapshot | undefined, next: SessionSnapshot): SessionPush => {
	if (last === undefined) return {_tag: "Snapshot", snapshot: next};
	if (!extendsTranscript(last.transcript, next.transcript)) {
		return {_tag: "Snapshot", snapshot: next};
	}
	if (last.name !== undefined && next.name === undefined) {
		return {_tag: "Snapshot", snapshot: next};
	}

	const items = changedItems(last.transcript, next.transcript);
	const steerMoved = !sameSteer(last, next);
	const delta: SessionDelta = {
		id: next.id,
		revision: next.revision,
		updatedAt: next.updatedAt,
		...(next.name === undefined || next.name === last.name ? {} : {name: next.name}),
		...(next.phase === last.phase ? {} : {phase: next.phase}),
		...(next.model.provider === last.model.provider && next.model.id === last.model.id
			? {}
			: {model: next.model}),
		...(next.thinkingLevel === last.thinkingLevel ? {} : {thinkingLevel: next.thinkingLevel}),
		...(next.attached === last.attached ? {} : {attached: next.attached}),
		...(next.locked === last.locked ? {} : {locked: next.locked}),
		...(steerMoved
			? {queuedSteer: [...next.queuedSteer], queuedSteerCount: next.queuedSteerCount}
			: {}),
		...(items.length === 0 ? {} : {items: [...items]}),
	};

	// Three keys are the address and the clock, not a change; a delta carrying only them says
	// nothing a viewer can render, and sending it would put a frame on the wire per silent bump.
	return Object.keys(delta).length === 3 ? {_tag: "Unchanged"} : {_tag: "Delta", delta};
};

/**
 * `base` moved on by one delta. Items land by id — a known id is replaced in place, an unknown one
 * is appended in the order the delta carries them — which is the same rule the client's own fold
 * runs (`../ai-agent/items.ts`), so the lease's whole value and the window's rows never disagree
 * about what the transcript is.
 */
export const applyDelta = (base: SessionSnapshot, delta: SessionDelta): SessionSnapshot => {
	const transcript = [...base.transcript];
	for (const item of delta.items ?? []) {
		const at = transcript.findIndex((held) => held.id === item.id);
		if (at === -1) transcript.push(item);
		else transcript[at] = item;
	}
	return {
		...base,
		revision: delta.revision,
		updatedAt: delta.updatedAt,
		...(delta.name === undefined ? {} : {name: delta.name}),
		...(delta.phase === undefined ? {} : {phase: delta.phase}),
		...(delta.model === undefined ? {} : {model: delta.model}),
		...(delta.thinkingLevel === undefined ? {} : {thinkingLevel: delta.thinkingLevel}),
		...(delta.attached === undefined ? {} : {attached: delta.attached}),
		...(delta.locked === undefined ? {} : {locked: delta.locked}),
		...(delta.queuedSteer === undefined
			? {}
			: {queuedSteer: [...delta.queuedSteer], queuedSteerCount: delta.queuedSteerCount ?? 0}),
		transcript,
	};
};
