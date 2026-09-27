/** A lane's record, derived from its log and facts — counts, asks, origin and the terminal key. */
import {describe, expect, it} from "vitest";
import type {Instant} from "../wire/lane-record.ts";
import {type LaneFact, parseFacts, standingOrigin, standingWait} from "./facts.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import type {LogEntry} from "./fold.ts";
import {compileText} from "./machine.ts";
import {asksInLog, composeRecord, LEDGER_SPEND, prsOf} from "./record.ts";

const compiled = compileText(coderTemplateText());
if (compiled._tag !== "Compiled") throw new Error("the coder template does not compile");
const LANE = compiled.lane;

let clock = 0;
const at = (): string => new Date(Date.UTC(2026, 8, 26, 6, 0, clock++)).toISOString();
const event = (name: string, extra: Partial<LogEntry> = {}): LogEntry => ({
	task: "issue",
	event: `ISSUE.${name}`,
	at: at(),
	...extra,
});

/** Two build rounds, a founder park at ship, a driver-routed park, and a merge. */
const shippedLog = (): ReadonlyArray<LogEntry> => {
	clock = 0;
	return [
		event("WIP"),
		event("BLOCKED"),
		event("UNBLOCKED"),
		event("DONE", {pr: "https://forge.test/o/r/pull/12"}),
		event("FAIL"),
		event("DONE", {pr: "https://forge.test/o/r/pull/12"}),
		event("PASS"),
		event("BLOCKED", {cause: "awaiting-cp-approval"}),
		event("UNBLOCKED"),
		event("DONE", {landed: [12]}),
	];
};

const compose = (entries: ReadonlyArray<LogEntry>, facts: ReadonlyArray<LaneFact> = []) =>
	composeRecord({issue: 42, lane: LANE, entries, facts, spent: LEDGER_SPEND});

describe("the lane record", () => {
	it("counts builds, reviews and parks off the replay, and reads the terminal off the fold", () => {
		const composed = compose(shippedLog());

		expect(composed._tag).toBe("Composed");
		if (composed._tag !== "Composed") return;
		const {record} = composed;
		expect(record.outcome).toBe("complete");
		expect(record.builds).toBe(2);
		expect(record.reviews).toBe(2);
		expect(record.parks.map(({leaf, cause, route}) => ({leaf, cause, route}))).toEqual([
			{leaf: "blocked", cause: null, route: "founder"},
			{leaf: "human:cp-approval", cause: "awaiting-cp-approval", route: "founder"},
		]);
		expect(record.prs).toEqual([12]);
		expect(record.terminalAt).toBe(shippedLog().at(-1)?.at);
		expect(record.log).toHaveLength(10);
		expect(record.spent).toEqual(LEDGER_SPEND);
	});

	it("derives asks as the founder-routed parks, and leaves a driver-routed park out", () => {
		clock = 0;
		const log = [event("WIP"), event("BLOCKED", {cause: "spawn-dead"}), event("UNBLOCKED")];

		expect(asksInLog(LANE, shippedLog())).toBe(2);
		expect(asksInLog(LANE, log)).toBe(0);
	});

	it("has no record for a lane that has not ended", () => {
		clock = 0;
		const composed = compose([event("WIP"), event("DONE")]);

		expect(composed).toMatchObject({
			_tag: "NotTerminal",
			stateValue: {pipeline: {issue: "review"}},
		});
	});

	it("reads origin and wait off the facts, starting the clock at the lane's opening", () => {
		const facts = parseFacts(
			[
				JSON.stringify({kind: "origin", origin: "bet", at: "2026-09-25T00:00:00.000Z"}),
				JSON.stringify({
					kind: "waiting",
					on: "legal",
					until: "2026-10-01",
					at: "2026-09-25T01:00:00.000Z",
				}),
			].join("\n"),
		);
		if (facts._tag !== "Parsed") throw new Error("facts did not parse");
		const composed = compose(shippedLog(), facts.facts);

		expect(composed).toMatchObject({
			_tag: "Composed",
			record: {
				origin: "bet",
				startedAt: "2026-09-25T00:00:00.000Z",
				waiting: {_tag: "Until", on: "legal"},
			},
		});
	});

	it("reads a lane with no origin fact as a driver pick", () => {
		const composed = compose(shippedLog());

		expect(composed).toMatchObject({
			_tag: "Composed",
			record: {origin: "driver-pick", waiting: {_tag: "None"}},
		});
	});
});

describe("the lane facts", () => {
	it("keeps the latest wait standing", () => {
		const parsed = parseFacts(
			[
				JSON.stringify({
					kind: "waiting",
					on: "a",
					until: "2026-10-01",
					at: "2026-09-25T00:00:00.000Z",
				}),
				JSON.stringify({
					kind: "waiting",
					on: "b",
					until: "2026-10-09",
					at: "2026-09-26T00:00:00.000Z",
				}),
			].join("\n"),
		);
		if (parsed._tag !== "Parsed") throw new Error("facts did not parse");

		expect(standingWait(parsed.facts)).toEqual({
			_tag: "Until",
			on: "b",
			until: "2026-10-09" as Instant,
		});
		expect(standingOrigin(parsed.facts)).toEqual({origin: "driver-pick", at: null});
	});

	it("refuses a second origin and a fact outside the two kinds", () => {
		const twice = JSON.stringify({kind: "origin", origin: "bet", at: "2026-09-25T00:00:00.000Z"});

		expect(parseFacts(`${twice}\n${twice}\n`)._tag).toBe("Malformed");
		expect(parseFacts(`${JSON.stringify({kind: "mood", at: "2026-09-25"})}\n`)._tag).toBe(
			"Malformed",
		);
		expect(parseFacts("not json\n")._tag).toBe("Malformed");
	});
});

describe("the pull requests a log names", () => {
	it("reads URLs, bare numbers and landed merges, once each", () => {
		expect(
			prsOf([
				{task: "issue", event: "ISSUE.DONE", at: "x", pr: "https://forge.test/o/r/pull/7"},
				{task: "issue", event: "ISSUE.DONE", at: "x", pr: "#3"},
				{task: "issue", event: "ISSUE.DONE", at: "x", landed: [7, 9]},
			]),
		).toEqual([3, 7, 9]);
	});
});
