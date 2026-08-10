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
