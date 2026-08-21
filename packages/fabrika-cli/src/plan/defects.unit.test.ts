import {describe, expect, it} from "vitest";
import type {RequiredEdge} from "../build/dependencies.ts";
import {SHIPPED_CONTAINMENT_VOCABULARY} from "../config/keys/containment-vocabulary.ts";
import {DEFECT_TYPES, type DefectType, deriveFloor, refsToProbe} from "./defects.ts";
import type {LedgerScope} from "./digest.ts";
import type {ChildLedger} from "./model.ts";

const child = (overrides: Partial<ChildLedger> = {}): ChildLedger => ({
	number: 4301,
	labels: ["p1", "status:planned", "type:feature"],
	assignees: [],
	assigneesObserved: true,
	criteria: "found",
	criteriaCount: 2,
	stories: [1],
	storiesValue: null,
	containment: "flag",
	...overrides,
});

const scope = (overrides: Partial<LedgerScope> = {}): LedgerScope => ({
	epic: 4300,
	children: [child()],
	epicStories: [1],
	cycleDoc: "present",
	topology: {phases: [{phase: 1, members: ["#4301"]}], edges: []},
	dependenciesAbsent: false,
	...overrides,
});

/** The board half of the floor's inputs: what the topology owes, and what the graph carries. */
interface Graph {
	readonly required?: ReadonlyArray<RequiredEdge>;
	readonly observed?: Readonly<Record<number, ReadonlyArray<number>>>;
}

const floorOf = (
	overrides: Partial<LedgerScope> = {},
	absent: ReadonlyArray<number> = [],
	graph: Graph = {},
) =>
	deriveFloor({
		ledger: scope(overrides),
		provenAbsent: new Set(absent),
		required: graph.required ?? [],
		observed: new Map(
			Object.entries(graph.observed ?? {}).map(([number, blockers]) => [
				Number.parseInt(number, 10),
				new Set(blockers),
			]),
		),
		vocabulary: SHIPPED_CONTAINMENT_VOCABULARY,
	});

const types = (
	overrides: Partial<LedgerScope> = {},
	absent: ReadonlyArray<number> = [],
	graph: Graph = {},
) => floorOf(overrides, absent, graph).defects.map((defect) => defect.type);

describe("a clean plan", () => {
	it("derives no defects and skips no class", () => {
		expect(floorOf()).toEqual({defects: [], skipped: []});
	});
});

describe("each of the fourteen types fires on its own condition", () => {
	it("MISSING_DEPS_SECTION", () => {
		expect(types({dependenciesAbsent: true})).toContain("MISSING_DEPS_SECTION");
	});

	it("DEP_CYCLE, reported once as its sorted member set", () => {
		const cyclic = floorOf({
			topology: {
				phases: [{phase: 1, members: ["#4301"]}],
				edges: [
					["#4301", "#4302"],
					["#4302", "#4301"],
				],
			},
			children: [child(), child({number: 4302})],
		});
		const cycles = cyclic.defects.filter((defect) => defect.type === "DEP_CYCLE");
		expect(cycles).toHaveLength(1);
		expect(cycles[0]?.refs).toEqual([4301, 4302]);
		expect(cycles[0]?.detail).toBe("cycle: #4301 → #4302 → #4301");
	});

	/**
	 * The probe decides absence; the floor only reads its answer. A ref that was *not* proven absent
	 * never becomes a defect — remove the `provenAbsent` test and an unreachable GitHub would start
	 * reporting every referenced issue as dangling.
	 */
	it("DANGLING_DEP only for a ref the probe proved absent", () => {
		const referenced = {
			topology: {phases: [{phase: 1, members: ["#4301", "#9999"]}], edges: []},
		};
		expect(types(referenced, [9999])).toContain("DANGLING_DEP");
		expect(types(referenced, [])).not.toContain("DANGLING_DEP");
	});

	/**
	 * The pre-fix state, in one assertion: epic #6595's shape — a phase-2 child requiring an open
	 * phase-1 decision — with the dependency in prose and nothing on the graph. Before `UNENFORCED_DEP`
	 * this floor read `clean`, `plan flip` made the child pickable, and `build claim` admitted it on
	 * `scanned 0 blocked_by edges` (#6616).
	 */
	it("UNENFORCED_DEP when the prose names an edge the graph does not carry", () => {
		const gated = {
			children: [child({number: 6597}), child({number: 6598})],
			topology: {
				phases: [
					{phase: 1, members: ["#6597"]},
					{phase: 2, members: ["#6598"]},
				],
				edges: [["#6598", "#6597"] as const],
			},
		};
		const required: ReadonlyArray<RequiredEdge> = [{dependent: 6598, prerequisite: 6597}];

		const blind = floorOf(gated, [], {required});
		const defect = blind.defects.find((row) => row.type === "UNENFORCED_DEP");
		expect(defect?.refs).toEqual([6597, 6598]);
		expect(defect?.detail).toBe("#6598 waits on #6597 in prose with no blocked_by edge");

		expect(types(gated, [], {required, observed: {6598: [6597]}})).not.toContain("UNENFORCED_DEP");
	});

	it("UNENFORCED_DEP yields to DANGLING_DEP when the prerequisite is proven absent", () => {
		const dangling = {
			topology: {phases: [{phase: 1, members: ["#4301", "#9999"]}], edges: []},
		};
		const required: ReadonlyArray<RequiredEdge> = [{dependent: 4301, prerequisite: 9999}];
		expect(types(dangling, [9999], {required})).not.toContain("UNENFORCED_DEP");
	});

	it("ORPHAN_CHILD", () => {
		expect(types({children: [child(), child({number: 4302})]})).toContain("ORPHAN_CHILD");
	});

	it("MISSING_STORIES_SECTION", () => {
		expect(types({epicStories: []})).toContain("MISSING_STORIES_SECTION");
	});

	it("UNCOVERED_STORY", () => {
		const uncovered = floorOf({epicStories: [1, 2]}).defects.find(
			(defect) => defect.type === "UNCOVERED_STORY",
		);
		expect(uncovered?.detail).toBe("story 2 is claimed by no child");
	});

	it.each([
		["absent", "acceptance criteria read as absent"],
		["malformed", "acceptance criteria read as malformed"],
	] as const)("ZERO_AC on a %s criteria read", (token, detail) => {
		const found = floorOf({children: [child({criteria: token, criteriaCount: 0})]}).defects.find(
			(defect) => defect.type === "ZERO_AC",
		);
		expect(found?.detail).toBe(detail);
	});

	it("ZERO_AC on a Found block with zero criteria", () => {
		expect(types({children: [child({criteriaCount: 0})]})).toContain("ZERO_AC");
	});

	it("MISSING_STORY, quoting a non-conforming value", () => {
		const found = floorOf({
			children: [child({stories: null, storiesValue: "1, 3 (see #4021)"})],
		}).defects.find((defect) => defect.type === "MISSING_STORY");
		expect(found?.detail).toBe('**Stories:** value does not conform: "1, 3 (see #4021)"');
	});

	it("MISSING_STORY only when the epic declares stories at all", () => {
		expect(types({epicStories: [], children: [child({stories: null})]})).not.toContain(
			"MISSING_STORY",
		);
	});

	it.each([
		[["p1", "status:planned"], "missing a type: label"],
		[["p1", "type:feature"], "missing a status: label"],
		[["status:planned", "type:feature"], "missing a priority label"],
	])("MISSING_LABEL for %s", (labels, detail) => {
		const found = floorOf({children: [child({labels})]}).defects.find(
			(defect) => defect.type === "MISSING_LABEL",
		);
		expect(found?.detail).toBe(detail);
	});

	/** `p3` was ruled retired, not widened (#4101, #2413) — it does not satisfy the priority slot. */
	it("MISSING_LABEL does not admit p3 as a priority", () => {
		expect(
			types({children: [child({labels: ["p3", "status:planned", "type:feature"]})]}),
		).toContain("MISSING_LABEL");
	});

	it.each([
		[null, "type:feature with containment unset"],
		["none" as const, "type:feature with containment none"],
	])("MISSING_CONTAINMENT for %s", (containment, detail) => {
		const found = floorOf({children: [child({containment})]}).defects.find(
			(defect) => defect.type === "MISSING_CONTAINMENT",
		);
		expect(found?.detail).toBe(detail);
	});

	it("NEEDS_TRIAGE_LABEL", () => {
		expect(
			types({children: [child({labels: ["p1", "status:needs-triage", "type:feature"]})]}),
		).toContain("NEEDS_TRIAGE_LABEL");
	});

	/**
	 * An unread field is UNKNOWN, never "unassigned is fine". Collapse `assigneesObserved` into an
	 * empty-array check and this class becomes unreachable while `HELD_CHILD_UNASSIGNED` starts
	 * firing on children nobody looked at.
	 */
	it("UNVERIFIABLE_ASSIGNEE when the payload carried no assignees key", () => {
		expect(types({children: [child({assignees: null, assigneesObserved: false})]})).toContain(
			"UNVERIFIABLE_ASSIGNEE",
		);
	});

	it("HELD_CHILD_UNASSIGNED on an observed-empty slot, never on an unobserved one", () => {
		const held = ["p1", "status:planned", "type:feature", "ready-for:human"];
		expect(types({children: [child({labels: held})]})).toContain("HELD_CHILD_UNASSIGNED");
		expect(
			types({children: [child({labels: held, assignees: null, assigneesObserved: false})]}),
		).not.toContain("HELD_CHILD_UNASSIGNED");
	});
});

describe("skipped", () => {
	/**
	 * v1 fused `absent` and `unknown` through a stderr substring match, so a transient probe failure
	 * silently switched the whole class off. Drop the `unknown` arm and an unreadable probe would read
	 * exactly like a repo with no cycle doc.
	 */
	it("names MISSING_CONTAINMENT only when the cycle-doc probe failed", () => {
		expect(floorOf({cycleDoc: "unknown"}).skipped).toEqual(["MISSING_CONTAINMENT"]);
		expect(floorOf({cycleDoc: "absent"}).skipped).toEqual([]);
	});

	it("does not derive the class on an unknown probe", () => {
		expect(types({cycleDoc: "unknown", children: [child({containment: null})]})).not.toContain(
			"MISSING_CONTAINMENT",
		);
	});

	it("derives the class and evaluates it false on an absent cycle doc", () => {
		expect(types({cycleDoc: "absent", children: [child({containment: null})]})).not.toContain(
			"MISSING_CONTAINMENT",
		);
	});

	it("a skipped class never makes a defective floor clean", () => {
		const floor = floorOf({cycleDoc: "unknown", children: [child({criteria: "absent"})]});
		expect(floor.skipped).toEqual(["MISSING_CONTAINMENT"]);
		expect(floor.defects.map((defect) => defect.type)).toContain("ZERO_AC");
	});
});

describe("the list is sorted by emission order, then by the lowest ref", () => {
	it("orders two types by the table and two of one type by ref", () => {
		const floor = floorOf({
			epicStories: [],
			children: [
				child({number: 4303, criteria: "absent"}),
				child({number: 4302, criteria: "absent"}),
			],
			topology: {phases: [{phase: 1, members: ["#4302", "#4303"]}], edges: []},
		});
		const emitted = floor.defects.map((defect) => `${defect.type}:${defect.refs[0]}`);
		expect(emitted).toEqual(["MISSING_STORIES_SECTION:4300", "ZERO_AC:4302", "ZERO_AC:4303"]);
	});

	it("every emitted type is in the closed enum", () => {
		const closed = new Set<DefectType>(DEFECT_TYPES);
		for (const type of types({dependenciesAbsent: true, epicStories: []})) {
			expect(closed.has(type)).toBe(true);
		}
	});
});

describe("refsToProbe", () => {
	it("names every referenced issue that is neither the epic nor a child", () => {
		expect(
			refsToProbe(
				scope({
					topology: {
						phases: [{phase: 1, members: ["#4301", "#4300", "#9999", "C1"]}],
						edges: [],
					},
				}),
			),
		).toEqual([9999]);
	});
});
