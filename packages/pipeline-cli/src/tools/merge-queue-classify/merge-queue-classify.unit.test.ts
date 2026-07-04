import {describe, expect, it} from "vitest";
import {classify, lastMergeQueueEvent, type MergeQueueSignals} from "./merge-queue-classify.ts";

const sig = (over: Partial<MergeQueueSignals> = {}): MergeQueueSignals => ({
	merged: false,
	state: "OPEN",
	lastMergeQueueEvent: null,
	mergeStateStatus: undefined,
	...over,
});

describe("classify — the #1921 falsifiable cases (would FAIL under the old logic)", () => {
	it("case 1 — fresh-enqueue race: OPEN + CLEAN + no merge-queue event ⇒ pending, NOT ejected (the #1906 race)", () => {
		// The old logic: OPEN + not merged + mergeStateStatus != QUEUED ⇒ ejected.
		// This is the exact live misfire on PR #1906 — must classify pending, never ejected.
		const c = classify(
			sig({merged: false, state: "OPEN", lastMergeQueueEvent: null, mergeStateStatus: "CLEAN"}),
		);
		expect(c.outcome).toBe("pending");
		expect(c.outcome).not.toBe("ejected");
	});

	it("case 2 — OPEN + CLEAN but added_to_merge_queue is the last event ⇒ queued", () => {
		// Same momentary CLEAN, but the authoritative timeline shows it was enqueued and
		// not removed — still queued, never ejected.
		const c = classify(
			sig({
				merged: false,
				state: "OPEN",
				lastMergeQueueEvent: "added_to_merge_queue",
				mergeStateStatus: "CLEAN",
			}),
		);
		expect(c.outcome).toBe("queued");
		expect(c.outcome).not.toBe("ejected");
	});

	it("case 3 — genuine ejection: last event removed_from_merge_queue, not merged ⇒ ejected", () => {
		const c = classify(
			sig({merged: false, state: "OPEN", lastMergeQueueEvent: "removed_from_merge_queue"}),
		);
		expect(c.outcome).toBe("ejected");
	});

	it("case 4 — merged ⇒ merged", () => {
		expect(classify(sig({merged: true})).outcome).toBe("merged");
		expect(classify(sig({merged: false, state: "MERGED"})).outcome).toBe("merged");
	});
});

describe("classify — precedence + edge cases", () => {
	it("merged wins over a trailing removed_from_merge_queue (the queue emits removal AS it merges — #1906)", () => {
		// #1906 carried both added_to_merge_queue AND removed_from_merge_queue, yet merged.
		const c = classify(
			sig({merged: true, state: "MERGED", lastMergeQueueEvent: "removed_from_merge_queue"}),
		);
		expect(c.outcome).toBe("merged");
	});

	it("mergeStateStatus==QUEUED ⇒ queued even with no timeline event yet (positive still-queued hint)", () => {
		const c = classify(sig({merged: false, state: "OPEN", mergeStateStatus: "QUEUED"}));
		expect(c.outcome).toBe("queued");
	});

	it("re-enqueue: add → remove → add ⇒ last event added ⇒ queued (last-event-wins survives re-enqueue)", () => {
		const c = classify(sig({lastMergeQueueEvent: "added_to_merge_queue"}));
		expect(c.outcome).toBe("queued");
	});

	it("no signal at all (OPEN, nothing) ⇒ pending, never ejected", () => {
		expect(classify(sig()).outcome).toBe("pending");
	});
});

describe("lastMergeQueueEvent — extract the last merge-queue event from a REST timeline", () => {
	it("returns null when the timeline carries no merge-queue event (the settle window)", () => {
		expect(
			lastMergeQueueEvent([
				{event: "labeled", created_at: "2026-07-03T10:00:00Z"},
				{event: "committed"},
			]),
		).toBeNull();
		expect(lastMergeQueueEvent([])).toBeNull();
	});

	it("returns added_to_merge_queue when it is the only / last merge-queue event", () => {
		expect(
			lastMergeQueueEvent([
				{event: "labeled", created_at: "2026-07-03T10:00:00Z"},
				{event: "added_to_merge_queue", created_at: "2026-07-03T10:01:00Z"},
			]),
		).toBe("added_to_merge_queue");
	});

	it("last-wins by created_at: add then remove ⇒ removed (a genuine ejection)", () => {
		expect(
			lastMergeQueueEvent([
				{event: "added_to_merge_queue", created_at: "2026-07-03T10:00:00Z"},
				{event: "removed_from_merge_queue", created_at: "2026-07-03T10:05:00Z"},
			]),
		).toBe("removed_from_merge_queue");
	});

	it("last-wins survives a re-enqueue: add → remove → add ⇒ added (still queued)", () => {
		expect(
			lastMergeQueueEvent([
				{event: "added_to_merge_queue", created_at: "2026-07-03T10:00:00Z"},
				{event: "removed_from_merge_queue", created_at: "2026-07-03T10:05:00Z"},
				{event: "added_to_merge_queue", created_at: "2026-07-03T10:10:00Z"},
			]),
		).toBe("added_to_merge_queue");
	});

	it("falls back to array position when created_at is absent (out-of-order tolerance)", () => {
		expect(
			lastMergeQueueEvent([{event: "added_to_merge_queue"}, {event: "removed_from_merge_queue"}]),
		).toBe("removed_from_merge_queue");
	});

	it("integration shape: the #1906 timeline (added then removed as it merged) resolves removed — merged is decided upstream by classify", () => {
		// classify() checks merged FIRST, so this removed event never reads as an ejection
		// on the merged PR — the pairing is tested in classify's precedence case above.
		expect(
			lastMergeQueueEvent([
				{event: "added_to_merge_queue", created_at: "2026-07-03T22:00:00Z"},
				{event: "removed_from_merge_queue", created_at: "2026-07-03T22:30:00Z"},
			]),
		).toBe("removed_from_merge_queue");
	});
});
