import {describe, expect, it} from "vitest";
import {ANSWER} from "../verb.ts";
import {DELIBERATE_GAP, TRIAGE_EXIT_TABLE} from "./codes.ts";
import {runCodes} from "./codes-verb.ts";

describe("runCodes", () => {
	it("prints one `<code>\\t<meaning>` line per allocated code", () => {
		const outcome = runCodes({json: false});
		const lines = outcome.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(TRIAGE_EXIT_TABLE.length);
		expect(lines[0]).toBe("0\tthe answer is on stdout");
		expect(lines.at(-1)).toBe("127\tthe verb never ran (unresolved binary)");
	});

	it("emits the table on stdout and the gap note on stderr — the answer channel is machine-only", () => {
		const outcome = runCodes({json: false});
		expect(outcome.stdout).not.toContain("unallocated");
		expect(outcome.stderr.join("\n")).toContain(`${DELIBERATE_GAP} is unallocated`);
	});

	it("swaps the line grammar for one JSON object under --json", () => {
		const outcome = runCodes({json: true});
		expect(outcome.stdout).not.toContain("\t");
		expect(JSON.parse(outcome.stdout)).toEqual({
			gap: DELIBERATE_GAP,
			codes: TRIAGE_EXIT_TABLE,
		});
	});

	it("always exits 0 — it reads nothing that could refuse", () => {
		expect(runCodes({json: false}).code).toBe(ANSWER);
		expect(runCodes({json: true}).code).toBe(ANSWER);
	});
});
