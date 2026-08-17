/** The stall derivation: which lanes are owed a driver, and how old their silence is. */
import {describe, expect, it} from "vitest";
import type {LaneStatus} from "./fold.ts";
import {activeLeaves, dispositionOf, isPark, judge, lastMoved} from "./stale.ts";

const active = (leaves: Record<string, string>): LaneStatus => ({
	stateValue: {pipeline: leaves, ship: "waiting"},
	status: "active",
	context: {},
});

const done: LaneStatus = {stateValue: "complete", status: "done", context: {}};

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

describe("isPark", () => {
	it("holds for the states only a human clears, and for nothing else", () => {
		expect(isPark("blocked")).toBe(true);
		expect(isPark("human:cp-approval")).toBe(true);
		expect(isPark("queued")).toBe(false);
		expect(isPark("build")).toBe(false);
	});
});

describe("activeLeaves", () => {
	it("reads the active phase's leaves and skips the waiting phases", () => {
		expect(activeLeaves(active({a: "build", b: "queued"}))).toEqual(["build", "queued"]);
	});

	it("answers none for a workflow folded onto a bare terminal", () => {
		expect(activeLeaves(done)).toEqual([]);
	});
});

describe("dispositionOf", () => {
	it("calls a finished workflow terminal", () => {
		expect(dispositionOf(done)).toBe("terminal");
	});

	it("calls a lane driven while any task routes to a shell", () => {
		expect(dispositionOf(active({a: "build"}))).toBe("driven");
		expect(dispositionOf(active({a: "human:cp-approval", b: "review"}))).toBe("driven");
	});

	it("calls a lane parked only when every task sits in a park", () => {
		expect(dispositionOf(active({a: "blocked"}))).toBe("parked");
		expect(dispositionOf(active({a: "blocked", b: "human:cp-approval"}))).toBe("parked");
	});

	it("keeps a queued task driven — nobody dispatching it is the silence, not a park", () => {
		expect(dispositionOf(active({a: "queued"}))).toBe("driven");
		expect(dispositionOf(active({a: "blocked", b: "queued"}))).toBe("driven");
	});
});

describe("lastMoved", () => {
	it("answers never on an empty log", () => {
		expect(lastMoved([])).toEqual({_tag: "Never"});
	});

	it("takes the maximum instant, not the last line", () => {
		const moved = lastMoved(["2026-08-17T10:00:00.000Z", "2026-08-17T09:00:00.000Z"]);

		expect(moved).toMatchObject({_tag: "Moved", at: "2026-08-17T10:00:00.000Z"});
	});

	it("keeps a log whose timestamps do not parse apart from a log with no events", () => {
		expect(lastMoved(["not a time"])).toEqual({_tag: "Unreadable"});
	});

	it("ignores an unparseable `at` beside a good one rather than losing the age", () => {
		expect(lastMoved(["nope", "2026-08-17T11:00:00.000Z"])).toMatchObject({
			at: "2026-08-17T11:00:00.000Z",
		});
	});
});

describe("judge", () => {
	const at = (minutes: number) => lastMoved([minutesAgo(minutes)]);

	it("calls a driven lane stale once its silence reaches the threshold", () => {
		expect(judge(active({a: "build"}), at(76), NOW, 60)).toEqual({
			verdict: "stale",
			ageMinutes: 76,
			lastEventAt: minutesAgo(76),
		});
		expect(judge(active({a: "build"}), at(60), NOW, 60).verdict).toBe("stale");
	});

	it("calls a driven lane moving below the threshold", () => {
		expect(judge(active({a: "review"}), at(59), NOW, 60)).toMatchObject({
			verdict: "moving",
			ageMinutes: 59,
		});
	});

	it("never calls a parked lane stale, however long it has sat", () => {
		expect(judge(active({a: "human:cp-approval"}), at(6000), NOW, 60)).toMatchObject({
			verdict: "parked",
			ageMinutes: 6000,
		});
	});

	it("never calls a terminal lane stale", () => {
		expect(judge(done, at(6000), NOW, 60)).toMatchObject({verdict: "terminal"});
	});

	it("calls a lane with no events unstarted — there is no age to judge", () => {
		expect(judge(active({a: "queued"}), lastMoved([]), NOW, 60)).toEqual({
			verdict: "unstarted",
			ageMinutes: null,
			lastEventAt: null,
		});
	});

	it("calls a lane whose timestamps do not parse unreadable, never moving", () => {
		expect(judge(active({a: "build"}), lastMoved(["nope"]), NOW, 60)).toMatchObject({
			verdict: "unreadable",
			ageMinutes: null,
		});
	});

	it("floors a clock that ran backwards at age 0 rather than reporting a negative silence", () => {
		expect(judge(active({a: "build"}), lastMoved([minutesAgo(-30)]), NOW, 60)).toMatchObject({
			verdict: "moving",
			ageMinutes: 0,
		});
	});

	it("takes the threshold from its argument — 0 makes every driven lane stale", () => {
		expect(judge(active({a: "build"}), at(0), NOW, 0).verdict).toBe("stale");
	});
});
