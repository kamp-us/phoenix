/**
 * The running list's model, without a DOM. What the list is a list *of* — which slots it shows, in
 * what order, how many the tail collapses into — is decided here, so it is proven here.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {describe, expect, it} from "vitest";
import {foldEvent} from "../../ai-agent/core/fold.ts";
import {initialState} from "../../ai-agent/core/state.ts";
import {subagentSlot} from "../../ai-agent-fixtures/transcripts.ts";
import {toAgentEvents} from "../../claude/history/events.ts";
import {loadFixture} from "../../claude/history/fixtures/load.ts";
import {emptyMapping} from "../../claude/history/map.ts";
import {
	elapsedLabel,
	runningSubagents,
	SUBAGENT_ROW_CAP,
	shownSubagents,
	subagentPhrase,
	tokenLabel,
} from "./subagents.ts";

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
					workers: 1,
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

describe("shownSubagents", () => {
	const worker = subagentSlot("a");
	const child = subagentSlot("b", {process: "p-9"});

	it("leaves the kernel children out while their flag is off", () => {
		expect(Object.keys(shownSubagents(slots(worker, child), false))).toEqual(["a"]);
	});

	it("shows both once the flag is on, and hands the set back untouched", () => {
		const all = slots(worker, child);
		expect(shownSubagents(all, true)).toBe(all);
	});
});

describe("a kernel child's row", () => {
	it("carries the process the slot named, so the row knows what activating it opens", () => {
		const model = runningSubagents(slots(subagentSlot("a", {process: "p-9"})));
		expect(model.rows[0]?.process).toBe("p-9");
	});

	it("carries no process for a worker the backend spawned, which is the other fact", () => {
		const model = runningSubagents(slots(subagentSlot("a")));
		expect(model.rows[0]).not.toHaveProperty("process");
	});
});

describe("subagentPhrase", () => {
	it("names one worker as the slot's own label, or the bare word when it has none", () => {
		expect(subagentPhrase("explorer")).toBe("explorer subagent");
		expect(subagentPhrase(null)).toBe("subagent");
		expect(subagentPhrase("explorer", 1)).toBe("explorer subagent");
	});

	// Every call site drops this into a sentence — "the … is still running", "the …'s transcript" —
	// so the count reads as an adjective rather than appended (founder ruling 2026-09-09 on #8664).
	it("carries a fan-out's worker count where the sentence still parses", () => {
		expect(subagentPhrase("explorer", 3)).toBe("3-worker explorer subagent");
		expect(subagentPhrase(null, 3)).toBe("3-worker subagent");
		expect(`The ${subagentPhrase("explorer", 3)} is still running.`).toBe(
			"The 3-worker explorer subagent is still running.",
		);
	});
});

/**
 * The list over a real background spawn, which is the shape it used to draw nothing for (#9506).
 *
 * Synthetic slots prove what the list does with a slot; only the captured frames prove there is a
 * slot to draw. So this folds `background-subagent-turn.json` through the same mapping and core the
 * window's process runs and asks the list after every frame.
 */
describe("runningSubagents over a captured background spawn", () => {
	const SPAWN = "toolu_000000000000000000000001";
	const frames = loadFixture("background-subagent-turn") as ReadonlyArray<SDKMessage>;

	/** The list model after each frame in turn, folded exactly as the live session folds it. */
	const perFrame = () => {
		const seen: Array<ReturnType<typeof runningSubagents>> = [];
		let mapping = emptyMapping;
		let state = initialState("/repo");
		for (const one of frames) {
			const step = toAgentEvents(one, mapping, {at: 1_700_000_000_000});
			mapping = step.mapping;
			state = step.events.reduce((carried, event) => foldEvent(carried, event, {}), state);
			seen.push(runningSubagents(state.subagents));
		}
		return seen;
	};

	it("draws the worker's row for every frame between the launch answer and the notification", () => {
		const seen = perFrame();
		expect(seen).toHaveLength(3);
		for (const model of seen.slice(0, 2)) {
			expect(model.rows.map((row) => row.id)).toEqual([SPAWN]);
			expect(model.rows[0]).toMatchObject({type: "Explore", status: "running", current: false});
			expect(model.more).toBe(0);
		}
	});

	it("drops the row once the notification ends the worker (Q2)", () => {
		expect(perFrame().at(-1)).toEqual({rows: [], more: 0});
	});
});
