/**
 * The running list's model, without a DOM. What the list is a list *of* — which slots it shows, in
 * what order, how many the tail collapses into — is decided here, so it is proven here.
 */

import {describe, expect, it} from "vitest";
import {subagentSlot} from "../../ai-agent-fixtures/transcripts.ts";
import {elapsedLabel, runningSubagents, SUBAGENT_ROW_CAP, tokenLabel} from "./subagents.ts";

const slots = (...entries: ReadonlyArray<ReturnType<typeof subagentSlot>>) =>
	Object.fromEntries(entries.map((slot) => [slot.id, slot]));

describe("runningSubagents", () => {
	it("is empty when nothing is running, so the window has no list to draw", () => {
		expect(runningSubagents({})).toEqual({rows: [], more: 0});
	});

	it("carries the four fields Q1 rules and no count of the rows a slot holds", () => {
		const model = runningSubagents(
			slots(subagentSlot("a", {type: "reviewer", lastLine: "reading rows.ts", tokens: 2_400})),
		);
		expect(model).toEqual({
			rows: [
				{
					id: "a",
					type: "reviewer",
					lastLine: "reading rows.ts",
					startedAt: 1_756_000_000_000,
					tokens: 2_400,
					status: "running",
					current: false,
				},
			],
			more: 0,
		});
	});

	it("drops a slot that has finished: it left the list the moment its worker stopped", () => {
		const model = runningSubagents(
			slots(subagentSlot("a"), subagentSlot("b", {status: "finished"})),
		);
		expect(model.rows.map((row) => row.id)).toEqual(["a"]);
	});

	it("orders the rows oldest-first, so a row does not move when another worker starts", () => {
		const model = runningSubagents(
			slots(
				subagentSlot("c", {startedAt: 30}),
				subagentSlot("a", {startedAt: 10}),
				subagentSlot("b", {startedAt: 20}),
			),
		);
		expect(model.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
	});

	it("breaks a tie on the id, so two workers started in one millisecond hold a stable order", () => {
		const model = runningSubagents(
			slots(subagentSlot("b", {startedAt: 10}), subagentSlot("a", {startedAt: 10})),
		);
		expect(model.rows.map((row) => row.id)).toEqual(["a", "b"]);
	});

	it("shows every row while the running set is inside the cap", () => {
		const running = Array.from({length: SUBAGENT_ROW_CAP}, (_, index) =>
			subagentSlot(`s${index}`, {startedAt: index}),
		);
		const model = runningSubagents(slots(...running));
		expect(model.rows).toHaveLength(SUBAGENT_ROW_CAP);
		expect(model.more).toBe(0);
	});

	it("shows five and counts the rest into the more row (Q3)", () => {
		const running = Array.from({length: 10}, (_, index) =>
			subagentSlot(`s${index}`, {startedAt: index}),
		);
		const model = runningSubagents(slots(...running));
		expect(model.rows.map((row) => row.id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
		expect(model.more).toBe(5);
	});

	it("counts only the running ones into the more row", () => {
		const running = Array.from({length: 10}, (_, index) =>
			subagentSlot(`s${index}`, {startedAt: index, status: index < 7 ? "running" : "finished"}),
		);
		expect(runningSubagents(slots(...running)).more).toBe(2);
	});
});

/**
 * The navigator's half (#8406). Which row is marked, and the one case the running set alone cannot
 * answer: the worker being read has stopped, and its row must still be in the list under Q9.
 */
describe("runningSubagents as the navigator", () => {
	it("marks the viewed worker and nothing else", () => {
		const model = runningSubagents(slots(subagentSlot("a"), subagentSlot("b")), "b");
		expect(model.rows.map((row) => [row.id, row.current])).toEqual([
			["a", false],
			["b", true],
		]);
	});

	it("keeps a finished worker in the list while it is the one being read (Q9)", () => {
		const model = runningSubagents(
			slots(subagentSlot("a"), subagentSlot("b", {status: "finished"})),
			"b",
		);
		expect(model.rows.map((row) => [row.id, row.status, row.current])).toEqual([
			["a", "running", false],
			["b", "finished", true],
		]);
		expect(model.more).toBe(0);
	});

	it("pulls a viewed worker in past the cap, and stops counting it as left off", () => {
		const running = Array.from({length: 10}, (_, index) =>
			subagentSlot(`s${index}`, {startedAt: index}),
		);
		const model = runningSubagents(slots(...running), "s9");
		expect(model.rows.map((row) => row.id)).toEqual(["s0", "s1", "s2", "s3", "s4", "s9"]);
		expect(model.rows.at(-1)?.current).toBe(true);
		expect(model.more).toBe(4);
	});

	it("marks nothing when the viewed id names no slot this session holds", () => {
		const model = runningSubagents(slots(subagentSlot("a")), "gone");
		expect(model.rows.map((row) => [row.id, row.current])).toEqual([["a", false]]);
	});
});

describe("elapsedLabel", () => {
	it("reads in seconds under a minute", () => {
		expect(elapsedLabel(0)).toBe("0s");
		expect(elapsedLabel(1_400)).toBe("1s");
		expect(elapsedLabel(59_999)).toBe("59s");
	});

	it("reads in minutes and seconds under an hour", () => {
		expect(elapsedLabel(60_000)).toBe("1m 00s");
		expect(elapsedLabel(125_000)).toBe("2m 05s");
		expect(elapsedLabel(3_599_000)).toBe("59m 59s");
	});

	it("reads in hours and minutes above one", () => {
		expect(elapsedLabel(3_600_000)).toBe("1h 00m");
		expect(elapsedLabel(7_500_000)).toBe("2h 05m");
	});

	// A checkpoint restored on a machine whose clock moved back leaves `now` behind `startedAt`, and
	// a negative duration would render as `-1s` rather than as the zero it means.
	it("clamps a clock that ran backwards to zero", () => {
		expect(elapsedLabel(-5_000)).toBe("0s");
	});
});

describe("tokenLabel", () => {
	it("reads a small count exactly", () => {
		expect(tokenLabel(0)).toBe("0");
		expect(tokenLabel(999)).toBe("999");
	});

	it("reads thousands compactly, dropping a zero decimal", () => {
		expect(tokenLabel(1_200)).toBe("1.2k");
		expect(tokenLabel(12_000)).toBe("12k");
	});

	it("reads millions compactly too", () => {
		expect(tokenLabel(1_250_000)).toBe("1.3M");
		expect(tokenLabel(4_000_000)).toBe("4M");
	});
});
