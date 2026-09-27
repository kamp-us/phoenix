/** The `lane-record` marker — its bytes, its read, and the derived rows the reader holds to. */
import {describe, expect, it} from "vitest";
import {
	asksOf,
	emit,
	emitFromFields,
	type Instant,
	type LaneRecord,
	read,
	wallClockSeconds,
} from "./lane-record.ts";

const RECORD: LaneRecord = {
	issue: 9855,
	outcome: "shipped",
	startedAt: "2026-09-26T06:48:00.000Z" as Instant,
	terminalAt: "2026-09-26T10:00:00.000Z" as Instant,
	builds: 2,
	reviews: 3,
	parks: [
		{
			task: "issue",
			leaf: "blocked",
			cause: null,
			route: "founder",
			at: "2026-09-26T07:00:00.000Z" as Instant,
		},
		{
			task: "issue",
			leaf: "human:budget-spent",
			cause: "repair-budget-spent",
			route: "driver",
			at: "2026-09-26T08:00:00.000Z" as Instant,
		},
	],
	spent: {_tag: "Unmeasured", reason: "no rate card"},
	origin: "bet",
	waiting: {_tag: "Until", on: "a | piped reviewer", until: "2026-10-05" as Instant},
	prs: [12, 40],
	log: ['{"task":"issue","event":"ISSUE.WIP","at":"2026-09-26T06:48:00.000Z","rationale":"```"}'],
};

describe("the lane-record format", () => {
	it("round-trips every field, including an escaped pipe and a backtick run in the log", () => {
		const bytes = emit(RECORD);
		const back = read(bytes);

		expect(back).toEqual({_tag: "Found", value: RECORD});
		expect(bytes).toContain("````jsonl");
	});

	it("carries the asks as the founder-routed parks and the wall-clock as its own span", () => {
		const bytes = emit(RECORD);

		expect(asksOf(RECORD)).toBe(1);
		expect(wallClockSeconds(RECORD)).toBe(11_520);
		expect(bytes).toContain("| Asks | 1 |");
		expect(bytes).toContain(
			"| Wall-clock | 3h 12m — from 2026-09-26T06:48:00.000Z to 2026-09-26T10:00:00.000Z |",
		);
		expect(bytes).toContain("| Spent $ | unmeasured — no rate card |");
		expect(bytes).toContain("| PRs | #12, #40 |");
	});

	it("reads an ordinary comment as Absent", () => {
		expect(read("Thanks, looks good.")._tag).toBe("Absent");
	});

	it("refuses an Asks row that disagrees with the parks", () => {
		const drifted = emit(RECORD).replace("| Asks | 1 |", "| Asks | 3 |");

		expect(read(drifted)).toMatchObject({
			_tag: "Malformed",
			reason: expect.stringContaining("Asks"),
		});
	});

	it("refuses a record whose table rows are missing", () => {
		const drifted = emit(RECORD).replace(/\| Origin \|.*\n/, "");

		expect(read(drifted)).toMatchObject({
			_tag: "Malformed",
			reason: expect.stringContaining("Origin"),
		});
	});

	it("refuses a record with no collapsed log", () => {
		const drifted = emit(RECORD).split("<details>")[0] ?? "";

		expect(read(drifted)._tag).toBe("Malformed");
	});

	it("never reads a table row from inside the log", () => {
		const record: LaneRecord = {...RECORD, log: ["| Asks | 9 |"]};

		expect(read(emit(record))).toEqual({_tag: "Found", value: record});
	});

	it("composes from JSON fields and refuses a record the reader could not hold", () => {
		expect(emitFromFields(JSON.stringify(RECORD))._tag).toBe("Composed");
		expect(emitFromFields(JSON.stringify({...RECORD, origin: "whim"}))).toMatchObject({
			_tag: "Unusable",
			reason: expect.stringContaining("origin"),
		});
		expect(
			emitFromFields(JSON.stringify({...RECORD, startedAt: "2026-09-27T00:00:00.000Z"})),
		).toMatchObject({
			_tag: "Unusable",
		});
	});
});
