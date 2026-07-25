import {describe, expect, it} from "vitest";
import {
	classify,
	lastMergeQueueEvent,
	type MergeQueueSignals,
	squashOnBaseBranch,
} from "./merge-queue-classify.ts";

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

describe("classify — the #4057 stale-timeline cases (the base-branch freshness cross-check)", () => {
	it("the #4011 shape: merge landed, PR still reads OPEN and the timeline still ends at added ⇒ merged", () => {
		// Every timeline/PR-state signal is the stale pre-merge state the reconcile observed for
		// ~65 minutes after PR #4011 merged. The base branch carries the squash, so it wins.
		const c = classify(
			sig({
				merged: false,
				state: "OPEN",
				lastMergeQueueEvent: "added_to_merge_queue",
				mergeStateStatus: "QUEUED",
				baseBranchSquash: "landed",
			}),
		);
		expect(c.outcome).toBe("merged");
	});

	it("a landed squash outranks a trailing removed_from_merge_queue on a stale not-merged read", () => {
		// The queue emits the removal AS it merges; with the PR read lagging, the removal alone
		// would classify `ejected` on a PR that in fact merged.
		const c = classify(
			sig({
				merged: false,
				state: "OPEN",
				lastMergeQueueEvent: "removed_from_merge_queue",
				baseBranchSquash: "landed",
			}),
		);
		expect(c.outcome).toBe("merged");
		expect(c.outcome).not.toBe("ejected");
	});

	it("fail-closed: `absent` never promotes — a genuinely queued PR stays queued", () => {
		const c = classify(
			sig({lastMergeQueueEvent: "added_to_merge_queue", baseBranchSquash: "absent"}),
		);
		expect(c.outcome).toBe("queued");
	});

	it("fail-closed: `absent` is not an ejection signal — a settling PR stays pending", () => {
		const c = classify(sig({lastMergeQueueEvent: null, baseBranchSquash: "absent"}));
		expect(c.outcome).toBe("pending");
		expect(c.outcome).not.toBe("ejected");
	});

	it("fail-closed: `unreadable` and an absent field both leave the timeline verdict untouched", () => {
		expect(
			classify(
				sig({lastMergeQueueEvent: "removed_from_merge_queue", baseBranchSquash: "unreadable"}),
			).outcome,
		).toBe("ejected");
		expect(classify(sig({lastMergeQueueEvent: "added_to_merge_queue"})).outcome).toBe("queued");
	});
});

describe("squashOnBaseBranch — does the scanned base-branch window carry this PR's squash?", () => {
	const squash = (message: string) => ({message, parents: 1});

	it("landed: a single-parent commit whose subject ends with (#PR)", () => {
		expect(
			squashOnBaseBranch(
				[squash("feat(ship-it): reconcile freshness (#4057)\n\nbody"), squash("chore: x (#4058)")],
				4057,
			),
		).toBe("landed");
	});

	it("absent: the window carries no commit for this PR", () => {
		expect(squashOnBaseBranch([squash("chore: x (#4058)")], 4057)).toBe("absent");
		expect(squashOnBaseBranch([], 4057)).toBe("absent");
	});

	it("ending-anchored: a squash citing another issue mid-subject is not that issue's squash", () => {
		// `fix(x): thing (#3924) (#4010)` is PR #4010's squash, never #3924's — a substring
		// match would report the cited issue as landed.
		const commits = [squash("fix(pipeline-cli): fail-closed stdin read (#3924) (#4010)")];
		expect(squashOnBaseBranch(commits, 4010)).toBe("landed");
		expect(squashOnBaseBranch(commits, 3924)).toBe("absent");
	});

	it("single-parent required: a two-parent merge commit mentioning the PR is not a squash", () => {
		expect(squashOnBaseBranch([{message: "Merge pull request (#4057)", parents: 2}], 4057)).toBe(
			"absent",
		);
	});

	it("tolerates a missing message or parent count", () => {
		expect(squashOnBaseBranch([{}, {message: "(#4057)"}], 4057)).toBe("absent");
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
