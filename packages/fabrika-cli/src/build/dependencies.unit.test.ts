import {describe, expect, it} from "vitest";
import {predecessorsOf, readTopology} from "./dependencies.ts";

const ledger = (body: string) => `# Epic\n\n## Dependencies\n\n${body}\n\n## Notes\n\nunrelated\n`;

describe("readTopology", () => {
	it("parses both line forms and stops at the next heading", () => {
		const read = readTopology(
			ledger("- phase 1: #210, #211\n- phase 2: #212\n- #212 requires: #210"),
		);
		expect(read._tag).toBe("Parsed");
		expect(read._tag === "Parsed" ? read.edges : []).toHaveLength(3);
	});

	it("reads a missing heading as Absent, not as an empty topology", () => {
		expect(readTopology("# Epic\n\nno section here\n")._tag).toBe("Absent");
	});

	it("refuses any other non-blank line — 'no parseable edges' is never 'no edges'", () => {
		const read = readTopology(ledger("- phase 1: #210\n- these two are related somehow"));
		expect(read._tag).toBe("Unparseable");
		expect(read._tag === "Unparseable" ? read.text : "").toBe("- these two are related somehow");
	});

	it("refuses a ref that is neither #<int> nor C<int>", () => {
		expect(readTopology(ledger("- phase 1: #210, PR-7"))._tag).toBe("Unparseable");
	});

	it("ends the section at a thematic break, so an appended amendment does not refuse it", () => {
		const read = readTopology(
			"# Epic\n\n## Dependencies\n\n- phase 1: #210\n- phase 2: #212\n\n---\n\n## Amendment — 2026-08-16\n\nnothing here parses as an edge\n",
		);
		expect(read._tag).toBe("Parsed");
		expect(read._tag === "Parsed" ? read.edges : []).toHaveLength(2);
	});

	it.each([
		"***",
		"___",
		"- - -",
		"   ---",
	])("ends the section at the %s spelling of a thematic break", (marker) => {
		const read = readTopology(
			`## Dependencies\n\n- phase 1: #210\n${marker}\nnot a topology line\n`,
		);
		expect(read._tag).toBe("Parsed");
		expect(read._tag === "Parsed" ? read.edges : []).toHaveLength(1);
	});

	it("keeps only the edges above the break", () => {
		const read = readTopology("## Dependencies\n\n- phase 1: #210\n\n---\n\n- phase 2: #212\n");
		expect(read._tag === "Parsed" ? read.edges : []).toEqual([
			{_tag: "Phase", phase: 1, members: [{_tag: "Issue", number: 210}]},
		]);
	});

	it("still refuses a garbage line reached before any break", () => {
		const read = readTopology("## Dependencies\n\n- phase 1: #210\nnot an edge\n\n---\n");
		expect(read._tag).toBe("Unparseable");
		expect(read._tag === "Unparseable" ? read.line : 0).toBe(4);
		expect(read._tag === "Unparseable" ? read.text : "").toBe("not an edge");
	});

	it("does not read a two-dash rule or a four-space-indented one as a break", () => {
		expect(readTopology("## Dependencies\n\n- phase 1: #210\n--\n")._tag).toBe("Unparseable");
		expect(readTopology("## Dependencies\n\n- phase 1: #210\n    ---\n")._tag).toBe("Unparseable");
	});
});

describe("predecessorsOf", () => {
	const edges = (body: string) => {
		const read = readTopology(ledger(body));
		return read._tag === "Parsed" ? read.edges : [];
	};

	it("honours an explicit requires: as the PRECISE gate, not the phase boundary", () => {
		const found = predecessorsOf(
			edges("- phase 1: #210, #211\n- phase 2: #212\n- #212 requires: #210"),
			{_tag: "Issue", number: 212},
		);
		expect(found).toEqual([{kind: "requires:", ref: {_tag: "Issue", number: 210}}]);
	});

	it("falls back to every earlier phase when the child has no requires: line", () => {
		const found = predecessorsOf(edges("- phase 1: #210, #211\n- phase 2: #212"), {
			_tag: "Issue",
			number: 212,
		});
		expect(found.map((row) => row.ref)).toEqual([
			{_tag: "Issue", number: 210},
			{_tag: "Issue", number: 211},
		]);
		expect(found.every((row) => row.kind === "phase")).toBe(true);
	});

	it("gives a phase-1 child no predecessors — a sibling in the same phase does not gate it", () => {
		expect(predecessorsOf(edges("- phase 1: #210, #211"), {_tag: "Issue", number: 211})).toEqual(
			[],
		);
	});

	it("gives an issue the topology never names no predecessors", () => {
		expect(predecessorsOf(edges("- phase 1: #210"), {_tag: "Issue", number: 999})).toEqual([]);
	});
});
