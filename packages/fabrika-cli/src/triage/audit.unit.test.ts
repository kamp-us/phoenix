import {describe, expect, it} from "vitest";
import {
	type Chunk,
	mergeChunks,
	parseAuditSet,
	parseChunk,
	parseVerdictRow,
	rowLine,
	VALUE_BAR_CLAUSES,
	type VerdictRow,
	verdictCounts,
} from "./audit.ts";

const kill = (issue: number): VerdictRow => ({
	issue,
	verdict: "KILL",
	clause: "superseded",
	evidence: "landed already",
});
const keep = (issue: number): VerdictRow => ({issue, verdict: "KEEP", evidence: "live bug"});

const chunk = (name: string, rows: ReadonlyArray<VerdictRow>, declared = rows.length): Chunk => ({
	name,
	declared,
	rows,
});

describe("parseVerdictRow", () => {
	it("decodes a KILL carrying its value-bar clause", () => {
		expect(
			parseVerdictRow({issue: 7, verdict: "KILL", clause: "superseded", evidence: "moot"}),
		).toEqual({
			_tag: "Parsed",
			value: {issue: 7, verdict: "KILL", clause: "superseded", evidence: "moot"},
		});
	});

	it("decodes a KEEP and a DECIDE, which carry no clause", () => {
		expect(parseVerdictRow({issue: 7, verdict: "KEEP", evidence: "live"})._tag).toBe("Parsed");
		expect(parseVerdictRow({issue: 8, verdict: "DECIDE", evidence: "two readings"})._tag).toBe(
			"Parsed",
		);
	});

	it("accepts every value-bar clause", () => {
		for (const clause of VALUE_BAR_CLAUSES) {
			expect(parseVerdictRow({issue: 1, verdict: "KILL", clause, evidence: "e"})._tag).toBe(
				"Parsed",
			);
		}
	});

	it("refuses an unknown verdict", () => {
		const out = parseVerdictRow({issue: 7, verdict: "CLOSE", evidence: "e"});
		expect(out).toMatchObject({_tag: "Refused"});
		expect(out._tag === "Refused" && out.reason).toContain("unknown verdict");
	});

	it("refuses a lower-case verdict — the vocabulary is exact", () => {
		expect(parseVerdictRow({issue: 7, verdict: "keep", evidence: "e"})._tag).toBe("Refused");
	});

	it("refuses a row with no issue number", () => {
		const out = parseVerdictRow({verdict: "KEEP", evidence: "e"});
		expect(out._tag === "Refused" && out.reason).toContain("no issue number");
	});

	it("refuses an issue that is not a positive integer", () => {
		expect(parseVerdictRow({issue: "7", verdict: "KEEP", evidence: "e"})._tag).toBe("Refused");
		expect(parseVerdictRow({issue: 0, verdict: "KEEP", evidence: "e"})._tag).toBe("Refused");
		expect(parseVerdictRow({issue: 7.5, verdict: "KEEP", evidence: "e"})._tag).toBe("Refused");
	});

	it("refuses a KILL with no value-bar clause", () => {
		const out = parseVerdictRow({issue: 7, verdict: "KILL", evidence: "e"});
		expect(out._tag === "Refused" && out.reason).toContain("KILL names no value-bar clause");
	});

	it("refuses a KILL naming a clause outside the value bar", () => {
		const out = parseVerdictRow({issue: 7, verdict: "KILL", clause: "boring", evidence: "e"});
		expect(out._tag === "Refused" && out.reason).toContain("not a value-bar clause");
	});

	it("refuses a clause on a KEEP — only a KILL carries one", () => {
		expect(
			parseVerdictRow({issue: 7, verdict: "KEEP", clause: "superseded", evidence: "e"})._tag,
		).toBe("Refused");
	});

	it("refuses a row with no evidence, or blank evidence", () => {
		expect(parseVerdictRow({issue: 7, verdict: "KEEP"})._tag).toBe("Refused");
		expect(parseVerdictRow({issue: 7, verdict: "KEEP", evidence: "  "})._tag).toBe("Refused");
	});

	it("refuses evidence spanning more than one line or carrying a tab", () => {
		expect(parseVerdictRow({issue: 7, verdict: "KEEP", evidence: "a\nb"})._tag).toBe("Refused");
		expect(parseVerdictRow({issue: 7, verdict: "KEEP", evidence: "a\tb"})._tag).toBe("Refused");
	});

	it("refuses an unknown key, so a misspelt clause cannot pass as absent", () => {
		const out = parseVerdictRow({issue: 7, verdict: "KEEP", evidence: "e", clasue: "superseded"});
		expect(out._tag === "Refused" && out.reason).toContain("clasue");
	});

	it("refuses a row that is not an object", () => {
		expect(parseVerdictRow([7, "KEEP"])._tag).toBe("Refused");
		expect(parseVerdictRow(null)._tag).toBe("Refused");
	});
});

describe("parseChunk", () => {
	it("keeps the declared total apart from the rows — decoding never reconciles them", () => {
		const out = parseChunk("a.json", {
			declared: 3,
			rows: [{issue: 1, verdict: "KEEP", evidence: "e"}],
		});
		expect(out).toEqual({
			_tag: "Parsed",
			value: {name: "a.json", declared: 3, rows: [{issue: 1, verdict: "KEEP", evidence: "e"}]},
		});
	});

	it("names the chunk and the row a malformed row sits at", () => {
		const out = parseChunk("a.json", {
			declared: 2,
			rows: [
				{issue: 1, verdict: "KEEP", evidence: "e"},
				{issue: 2, verdict: "KILL", evidence: "e"},
			],
		});
		expect(out._tag === "Refused" && out.reason).toContain("a.json: row 2:");
	});

	it("refuses a chunk with no declared total", () => {
		expect(parseChunk("a.json", {rows: []})._tag).toBe("Refused");
		expect(parseChunk("a.json", {declared: -1, rows: []})._tag).toBe("Refused");
	});
});

describe("parseAuditSet", () => {
	const set = (issues: ReadonlyArray<unknown>, scanned: unknown = issues.length) => ({
		outcome: "set",
		issues,
		scanned,
	});

	it("decodes the set `triage audit-set --json` prints", () => {
		expect(parseAuditSet(set([{number: 4, title: "t"}]))).toEqual({
			_tag: "Parsed",
			value: [{number: 4, title: "t"}],
		});
	});

	it("refuses a set whose scanned count is not the issues it lists", () => {
		expect(parseAuditSet(set([{number: 4, title: "t"}], 2))._tag).toBe("Refused");
	});

	it("refuses a set listing one issue twice", () => {
		expect(
			parseAuditSet(
				set([
					{number: 4, title: "t"},
					{number: 4, title: "t"},
				]),
			)._tag,
		).toBe("Refused");
	});
});

describe("mergeChunks", () => {
	it("merges every row, ascending by issue", () => {
		const out = mergeChunks([1, 2, 3], [chunk("a", [keep(3), kill(1)]), chunk("b", [keep(2)])]);
		expect(out).toEqual({_tag: "Merged", rows: [kill(1), keep(2), keep(3)]});
	});

	it("refuses a chunk whose rows differ from its declared total", () => {
		const out = mergeChunks([1, 2, 3], [chunk("a", [keep(1), keep(2)], 3), chunk("b", [keep(3)])]);
		expect(out).toEqual({
			_tag: "CountMismatch",
			chunks: [{name: "a", declared: 3, actual: 2}],
		});
	});

	it("checks the count before the set, so a short chunk is named rather than its missing issue", () => {
		const out = mergeChunks([1, 2], [chunk("a", [keep(1)], 2)]);
		expect(out._tag).toBe("CountMismatch");
	});

	it("refuses an issue judged in more than one row, naming every chunk that judged it", () => {
		const out = mergeChunks([1, 2], [chunk("a", [keep(1), keep(2)]), chunk("b", [kill(2)])]);
		expect(out).toEqual({_tag: "Duplicate", issues: [{issue: 2, chunks: ["a", "b"]}]});
	});

	it("refuses an issue judged twice inside one chunk", () => {
		expect(mergeChunks([1], [chunk("a", [keep(1), kill(1)])])._tag).toBe("Duplicate");
	});

	it("refuses a merged set missing an audited issue", () => {
		expect(mergeChunks([1, 2, 3], [chunk("a", [keep(1), keep(3)])])).toEqual({
			_tag: "SetMismatch",
			missing: [2],
			invented: [],
		});
	});

	it("refuses a row naming an issue the audit never listed", () => {
		expect(mergeChunks([1], [chunk("a", [keep(1), kill(9)])])).toEqual({
			_tag: "SetMismatch",
			missing: [],
			invented: [9],
		});
	});
});

describe("rowLine and verdictCounts", () => {
	it("prints `-` in the clause column of a clause-less verdict", () => {
		expect(rowLine(keep(2))).toBe("2\tKEEP\t-\tlive bug");
		expect(rowLine(kill(1))).toBe("1\tKILL\tsuperseded\tlanded already");
	});

	it("counts each verdict", () => {
		expect(verdictCounts([kill(1), keep(2), keep(3)])).toEqual({KILL: 1, DECIDE: 0, KEEP: 2});
	});
});
