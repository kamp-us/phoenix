/**
 * T0 unit tests for the pure pickable/blocked + phase-progress derivation (#256).
 * No React, no fetch — total functions over plain data (ADR 0040,
 * `.patterns/effect-testing.md`). Fixtures model the open/closed/`requires:`
 * permutations from `.claude/skills/gh-issue-intake-formats.md` §Dependencies.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	type ChildFacts,
	deriveChild,
	deriveChildren,
	derivePhaseProgress,
	type EpicTopology,
} from "./epic.ts";

const stateMap = (
	entries: ReadonlyArray<[number, "open" | "closed"]>,
): ReadonlyMap<number, "open" | "closed"> => new Map(entries);

const child = (number: number, state: "open" | "closed", status: string | null): ChildFacts => ({
	number,
	state,
	status,
});

// The worked example from the formats contract: Phase 1 {#210, #211} parallel,
// Phase 2 {#212 (requires: #210), #213}.
const workedTopology: EpicTopology = {
	children: [210, 211, 212, 213],
	phases: [
		{phase: 1, issues: [210, 211]},
		{phase: 2, issues: [212, 213]},
	],
	requires: [{from: 212, to: 210}],
};

describe("deriveChild — triage gate", () => {
	it("a non-triaged child is unpickable regardless of deps", () => {
		const d = deriveChild(child(210, "open", "planned"), workedTopology, stateMap([]));
		assert.strictEqual(d.pickability.kind, "not-triaged");
	});

	it("an untriaged child (no status) is not-triaged", () => {
		const d = deriveChild(child(210, "open", null), workedTopology, stateMap([]));
		assert.strictEqual(d.pickability.kind, "not-triaged");
	});

	it("triage gate takes precedence over an otherwise-satisfied dep gate", () => {
		// #212 requires #210 closed; even with #210 closed, a non-triaged #212 stays unpickable.
		const d = deriveChild(
			child(212, "open", "needs-info"),
			workedTopology,
			stateMap([[210, "closed"]]),
		);
		assert.strictEqual(d.pickability.kind, "not-triaged");
	});
});

describe("deriveChild — requires: precise gate", () => {
	it("blocks a triaged child whose requires: target is open", () => {
		const d = deriveChild(child(212, "open", "triaged"), workedTopology, stateMap([[210, "open"]]));
		assert.strictEqual(d.pickability.kind, "blocked");
		if (d.pickability.kind === "blocked") assert.match(d.pickability.reason, /requires #210/);
	});

	it("makes the child pickable once its requires: target closes", () => {
		const d = deriveChild(
			child(212, "open", "triaged"),
			workedTopology,
			stateMap([[210, "closed"]]),
		);
		assert.strictEqual(d.pickability.kind, "pickable");
	});

	it("requires: is the precise gate — a phase-1 sibling (#211) staying open does NOT block #212", () => {
		// #212 only requires #210; #211 is a phase-1 sibling but not in #212's requires.
		const d = deriveChild(
			child(212, "open", "triaged"),
			workedTopology,
			stateMap([
				[210, "closed"],
				[211, "open"],
			]),
		);
		assert.strictEqual(d.pickability.kind, "pickable");
	});

	it("lists every open requires: target in the reason", () => {
		const topology: EpicTopology = {
			children: [1, 2, 3],
			phases: [{phase: 1, issues: [3]}],
			requires: [
				{from: 3, to: 1},
				{from: 3, to: 2},
			],
		};
		const d = deriveChild(
			child(3, "open", "triaged"),
			topology,
			stateMap([
				[1, "open"],
				[2, "closed"],
			]),
		);
		assert.strictEqual(d.pickability.kind, "blocked");
		if (d.pickability.kind === "blocked") {
			assert.match(d.pickability.reason, /#1/);
			assert.notMatch(d.pickability.reason, /#2/); // #2 is closed, not blocking
		}
	});
});

describe("deriveChild — phase-boundary default (no requires:)", () => {
	it("blocks a phase-2 child with no requires: while any phase-1 issue is open", () => {
		// #213 is in Phase 2 with no requires:, so it waits on ALL of Phase 1.
		const d = deriveChild(
			child(213, "open", "triaged"),
			workedTopology,
			stateMap([
				[210, "closed"],
				[211, "open"],
			]),
		);
		assert.strictEqual(d.pickability.kind, "blocked");
		if (d.pickability.kind === "blocked") assert.match(d.pickability.reason, /waiting on Phase 1/);
	});

	it("makes a phase-2 no-requires child pickable when all of phase 1 is closed", () => {
		const d = deriveChild(
			child(213, "open", "triaged"),
			workedTopology,
			stateMap([
				[210, "closed"],
				[211, "closed"],
			]),
		);
		assert.strictEqual(d.pickability.kind, "pickable");
	});

	it("a phase-1 child (no predecessors) is pickable when triaged", () => {
		const d = deriveChild(child(210, "open", "triaged"), workedTopology, stateMap([]));
		assert.strictEqual(d.pickability.kind, "pickable");
	});

	it("names multiple open earlier phases in the reason", () => {
		const topology: EpicTopology = {
			children: [1, 2, 3],
			phases: [
				{phase: 1, issues: [1]},
				{phase: 2, issues: [2]},
				{phase: 3, issues: [3]},
			],
			requires: [],
		};
		const d = deriveChild(
			child(3, "open", "triaged"),
			topology,
			stateMap([
				[1, "open"],
				[2, "open"],
			]),
		);
		assert.strictEqual(d.pickability.kind, "blocked");
		if (d.pickability.kind === "blocked")
			assert.match(d.pickability.reason, /waiting on Phases 1, 2/);
	});
});

describe("deriveChild — fail-closed on unknown state", () => {
	it("treats an issue absent from the state map as open (unproven closure does not satisfy a gate)", () => {
		const d = deriveChild(child(212, "open", "triaged"), workedTopology, stateMap([]));
		assert.strictEqual(d.pickability.kind, "blocked");
	});

	it("a child not on the phase spine and with no requires: is pickable when triaged", () => {
		const topology: EpicTopology = {
			children: [99],
			phases: [{phase: 1, issues: [1]}],
			requires: [],
		};
		const d = deriveChild(child(99, "open", "triaged"), topology, stateMap([]));
		assert.strictEqual(d.pickability.kind, "pickable");
	});
});

describe("deriveChildren", () => {
	it("derives every child in one pass", () => {
		const children = [
			child(210, "closed", "triaged"),
			child(211, "open", "triaged"),
			child(212, "open", "triaged"),
			child(213, "open", "triaged"),
		];
		const stateOf = stateMap([
			[210, "closed"],
			[211, "open"],
			[212, "open"],
			[213, "open"],
		]);
		const out = deriveChildren(children, workedTopology, stateOf);
		assert.strictEqual(out.length, 4);
		const byNum = new Map(out.map((d) => [d.number, d.pickability.kind]));
		assert.strictEqual(byNum.get(210), "pickable"); // phase 1, no preds
		assert.strictEqual(byNum.get(211), "pickable"); // phase 1, no preds
		assert.strictEqual(byNum.get(212), "pickable"); // requires #210, which is closed
		assert.strictEqual(byNum.get(213), "blocked"); // phase 2, #211 still open
	});
});

describe("derivePhaseProgress", () => {
	it("reports the current phase as the earliest not-fully-closed phase", () => {
		const children = [
			child(210, "closed", "triaged"),
			child(211, "closed", "triaged"),
			child(212, "open", "triaged"),
			child(213, "open", "triaged"),
		];
		const stateOf = stateMap([
			[210, "closed"],
			[211, "closed"],
			[212, "open"],
			[213, "open"],
		]);
		const p = derivePhaseProgress(children, workedTopology, stateOf);
		assert.strictEqual(p.currentPhase, 2);
		assert.strictEqual(p.totalPhases, 2);
		assert.strictEqual(p.closedChildren, 2);
		assert.strictEqual(p.totalChildren, 4);
		assert.strictEqual(p.label, "Phase 2 of 2 · 2/4 children closed");
	});

	it("current phase is phase 1 when phase 1 still has an open issue", () => {
		const children = [child(210, "open", "triaged"), child(211, "closed", "triaged")];
		const stateOf = stateMap([
			[210, "open"],
			[211, "closed"],
		]);
		const p = derivePhaseProgress(children, workedTopology, stateOf);
		assert.strictEqual(p.currentPhase, 1);
	});

	it("reports all-complete when every phase is closed", () => {
		const children = [
			child(210, "closed", "triaged"),
			child(211, "closed", "triaged"),
			child(212, "closed", "triaged"),
			child(213, "closed", "triaged"),
		];
		const stateOf = stateMap([
			[210, "closed"],
			[211, "closed"],
			[212, "closed"],
			[213, "closed"],
		]);
		const p = derivePhaseProgress(children, workedTopology, stateOf);
		assert.strictEqual(p.currentPhase, null);
		assert.strictEqual(p.label, "All phases complete · 4/4 children closed");
	});

	it("a topology with no phases reports just the child tally", () => {
		const children = [child(1, "closed", "triaged"), child(2, "open", "triaged")];
		const topology: EpicTopology = {children: [1, 2], phases: [], requires: []};
		const p = derivePhaseProgress(children, topology, stateMap([]));
		assert.strictEqual(p.totalPhases, 0);
		assert.strictEqual(p.currentPhase, null);
		assert.strictEqual(p.label, "1/2 children closed");
	});

	it("counts closed children across the whole sub_issues set, not just phase members", () => {
		// #99 is a child but not on the phase spine; its closure still counts toward progress.
		const topology: EpicTopology = {
			children: [210, 99],
			phases: [{phase: 1, issues: [210]}],
			requires: [],
		};
		const children = [child(210, "open", "triaged"), child(99, "closed", "triaged")];
		const p = derivePhaseProgress(children, topology, stateMap([[210, "open"]]));
		assert.strictEqual(p.closedChildren, 1);
		assert.strictEqual(p.totalChildren, 2);
	});
});
