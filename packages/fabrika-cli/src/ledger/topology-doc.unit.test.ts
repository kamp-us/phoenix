import {describe, expect, it} from "vitest";
import {readTopology} from "../build/dependencies.ts";
import {
	checkTopology,
	type DeclaredLine,
	findCycle,
	parseLine,
	renderDependencies,
} from "./topology-doc.ts";

const line = (
	child: number,
	phase: number,
	requires: ReadonlyArray<number> = [],
): DeclaredLine => ({
	child,
	phase,
	requires,
});

describe("parseLine", () => {
	it("reads a bare phase line", () => {
		expect(parseLine("#4301 phase 1", 1)).toEqual({_tag: "Line", line: line(4301, 1)});
	});

	it("reads a requires clause, single and comma-separated", () => {
		expect(parseLine("#4303 phase 2 requires #4301", 1)).toEqual({
			_tag: "Line",
			line: line(4303, 2, [4301]),
		});
		expect(parseLine("#4303 phase 2 requires #4301, #4302", 1)).toEqual({
			_tag: "Line",
			line: line(4303, 2, [4301, 4302]),
		});
	});

	it("refuses a line off the grammar", () => {
		expect(parseLine("4301 in phase one", 7)).toEqual({
			_tag: "Unparseable",
			index: 7,
			text: "4301 in phase one",
		});
	});

	/** A phase off its closed vocabulary is a semantic refusal (`10`), not a malformed-flag `4`. */
	it("separates a non-integer phase from an unparseable line", () => {
		expect(parseLine("#4301 phase two", 1)).toEqual({_tag: "OffVocabulary", phase: "two"});
		expect(parseLine("#4301 phase 0", 1)).toEqual({_tag: "OffVocabulary", phase: "0"});
	});
});

describe("renderDependencies", () => {
	it("renders phases ascending, members ascending, then the requires lines", () => {
		expect(renderDependencies([line(4302, 1), line(4301, 1), line(4303, 2, [4301])])).toBe(
			"## Dependencies\n\n- phase 1: #4301, #4302\n- phase 2: #4303\n- #4303 requires: #4301\n",
		);
	});

	/**
	 * The whole point of composing here rather than in the skill: the block the gate's parser reads is
	 * the block this verb wrote, proven by parsing it back through that very parser.
	 */
	it("round-trips through the shipped `readTopology`", () => {
		const parsed = readTopology(renderDependencies([line(4301, 1), line(4303, 2, [4301])]));
		expect(parsed).toMatchObject({_tag: "Parsed"});
		expect(parsed._tag === "Parsed" && parsed.edges).toEqual([
			{_tag: "Phase", phase: 1, members: [{_tag: "Issue", number: 4301}]},
			{_tag: "Phase", phase: 2, members: [{_tag: "Issue", number: 4303}]},
			{
				_tag: "Requires",
				subject: {_tag: "Issue", number: 4303},
				needs: [{_tag: "Issue", number: 4301}],
			},
		]);
	});
});

describe("findCycle", () => {
	it("finds a two-node cycle through requires edges", () => {
		expect(findCycle([line(1, 1, [2]), line(2, 1, [1])])).toEqual([1, 2, 1]);
	});

	/** A requires that contradicts its phases is a cycle in the union graph, and says so. */
	it("finds a cycle a backwards requires creates against the phase order", () => {
		expect(findCycle([line(1, 1, [2]), line(2, 2)])).not.toBeNull();
	});

	it("finds none in a plain forward topology", () => {
		expect(findCycle([line(1, 1), line(2, 2, [1])])).toBeNull();
	});
});

describe("checkTopology", () => {
	it("stages a topology that places every manifest child exactly once", () => {
		expect(checkTopology(4300, [line(4301, 1), line(4303, 2, [4301])], [4301, 4303])).toMatchObject(
			{
				_tag: "Ok",
				phases: 2,
				edges: [["#4303", "#4301"]],
			},
		);
	});

	it("refuses a manifest child placed in no phase", () => {
		expect(checkTopology(4300, [line(4301, 1)], [4301, 4302])).toEqual({
			_tag: "Invalid",
			reason: "child #4302 is placed in no phase.",
		});
	});

	it("refuses a reference to something that is not a child", () => {
		expect(checkTopology(4300, [line(4301, 1), line(4302, 2, [9999])], [4301, 4302])).toEqual({
			_tag: "Invalid",
			reason: "#9999 is referenced but is not a child of #4300.",
		});
	});

	it("refuses a child declared twice", () => {
		expect(checkTopology(4300, [line(4301, 1), line(4301, 2)], [4301])).toEqual({
			_tag: "Invalid",
			reason: "#4301 is declared 2 times — a child sits in exactly one phase.",
		});
	});

	it("refuses a cycle and names its members", () => {
		expect(
			checkTopology(4300, [line(4301, 1, [4302]), line(4302, 1, [4301])], [4301, 4302]),
		).toEqual({
			_tag: "Invalid",
			reason: "cycle: #4301 → #4302 → #4301",
		});
	});
});
