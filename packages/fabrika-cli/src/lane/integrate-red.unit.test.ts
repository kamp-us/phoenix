import {describe, expect, it} from "vitest";
import {instant} from "../wire/lane-record.ts";
import {
	describeOutput,
	encodeRedRecord,
	type IntegrateRedRecord,
	KEPT_LINES,
	keepOutput,
	latestRedRecord,
	parseRedRecords,
} from "./integrate-red.ts";

const numbered = (count: number, last: string): string =>
	[...Array.from({length: count}, (_, i) => `line ${i + 1}`), last].join("\n");

describe("keepOutput", () => {
	it("keeps the end of a stream, where a task runner prints its failures, and counts what it dropped", () => {
		const kept = keepOutput(numbered(60, "FAIL a.test.ts"), "");

		expect(kept.stdout.lines).toHaveLength(KEPT_LINES);
		expect(kept.stdout.lines.at(-1)).toBe("FAIL a.test.ts");
		expect(kept.stdout.omitted).toBe(21);
	});

	it("keeps both streams, so failures on stdout survive a non-empty stderr", () => {
		const kept = keepOutput("FAIL a.test.ts\n", "WARN deprecated\n");

		expect(kept.stdout.lines).toEqual(["FAIL a.test.ts"]);
		expect(kept.stderr.lines).toEqual(["WARN deprecated"]);
	});

	it("labels each stream on stderr and names the cut", () => {
		const lines = describeOutput(keepOutput(numbered(50, "FAIL"), "warn"));

		expect(lines[0]).toBe("--- stderr ---");
		expect(lines).toContain("--- stdout (last 40 line(s); 11 earlier line(s) dropped) ---");
		expect(lines.at(-1)).toBe("FAIL");
	});
});

describe("the record file", () => {
	const at = instant("2026-10-04T00:00:00.000Z");
	if (at === null) throw new Error("the fixture instant does not parse");
	const record = (child: string, head: string): IntegrateRedRecord => ({
		at,
		child,
		head,
		merged: {validator: "pnpm test", output: keepOutput("FAIL", "")},
		base: {verdict: "green"},
	});

	it("round-trips, and refuses a line it cannot decode rather than skipping it", () => {
		const one = record("build/7-a-1234abcd", "a".repeat(40));
		expect(parseRedRecords(encodeRedRecord(one))).toEqual({_tag: "Parsed", records: [one]});
		expect(parseRedRecords(`${encodeRedRecord(one)}{"child":"x"}\n`)._tag).toBe("Malformed");
	});

	it("finds the latest record for this child at this head, matching a short head", () => {
		const older = record("build/7-a-1234abcd", "a".repeat(40));
		const other = record("build/70-b-1234abcd", "a".repeat(40));
		const newer = {...older, base: {verdict: "red", output: keepOutput("x", "")}} as const;

		expect(latestRedRecord([older, other, newer], "aaaaaaa", 7)).toBe(newer);
		expect(latestRedRecord([other], "aaaaaaa", 7)).toBeNull();
		expect(latestRedRecord([older], "bbbbbbb", 7)).toBeNull();
	});
});
