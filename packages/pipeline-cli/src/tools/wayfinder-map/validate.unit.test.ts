import {assert, describe, it} from "@effect/vitest";
import {DEFECT_TYPES, type DefectType} from "./Defect.ts";
import {ledger, map} from "./fixtures.ts";
import type {WayfinderMapLedger} from "./Map.ts";
import {
	answerableFrontier,
	isGraduationReady,
	isValidMap,
	mapSignature,
	validateMap,
} from "./validate.ts";

const typesOf = (l: WayfinderMapLedger): ReadonlyArray<DefectType> =>
	validateMap(l).map((d) => d.type);

describe("validateMap — the clean golden case", () => {
	it("a well-formed map has zero defects and is valid", () => {
		const l = ledger();
		assert.deepStrictEqual(validateMap(l), []);
		assert.strictEqual(isValidMap(l), true);
		assert.strictEqual(mapSignature(l), "clean");
	});
});

describe("validateMap — missing sections", () => {
	it("MISSING_DESTINATION when the map has no `## Destination`", () => {
		const l = ledger({map: map({destination: {present: false, text: ""}})});
		assert.include(typesOf(l), "MISSING_DESTINATION");
		// A section that is simply absent is NOT also flagged empty.
		assert.notInclude(typesOf(l), "EMPTY_DESTINATION");
	});

	it("MISSING_DECISIONS_SECTION when there is no `## Decisions-so-far`", () => {
		const l = ledger({map: map({decisionsSoFar: {present: false, entries: []}})});
		assert.include(typesOf(l), "MISSING_DECISIONS_SECTION");
	});

	it("MISSING_FRONTIER_SECTION when there is no `## Open frontier`", () => {
		const l = ledger({map: map({openFrontier: {present: false, entries: []}})});
		assert.include(typesOf(l), "MISSING_FRONTIER_SECTION");
	});

	it("MISSING_FOG_SECTION when there is no `## Graduated fog`", () => {
		const l = ledger({map: map({graduatedFog: {present: false, entries: []}})});
		assert.include(typesOf(l), "MISSING_FOG_SECTION");
	});
});

describe("validateMap — malformed entries", () => {
	it("EMPTY_DESTINATION when the heading exists but names no end-state", () => {
		const l = ledger({map: map({destination: {present: true, text: ""}})});
		assert.include(typesOf(l), "EMPTY_DESTINATION");
	});

	it("MALFORMED_DECISION_ENTRY when a decision has no `— from #N` origin", () => {
		const l = ledger({
			map: map({decisionsSoFar: {present: true, entries: [{text: "We chose X."}]}}),
		});
		assert.include(typesOf(l), "MALFORMED_DECISION_ENTRY");
	});

	it("MALFORMED_FRONTIER_ENTRY when a frontier ticket references no sub-issue", () => {
		const l = ledger({
			map: map({
				openFrontier: {
					present: true,
					entries: [
						{issue: undefined, question: "how do invites work?", founderDecisionFork: false},
					],
				},
			}),
		});
		assert.include(typesOf(l), "MALFORMED_FRONTIER_ENTRY");
	});

	it("MALFORMED_FOG_ENTRY when a fog entry references no issue", () => {
		const l = ledger({
			map: map({
				graduatedFog: {present: true, entries: [{issue: undefined, note: "done", spawned: []}]},
			}),
		});
		assert.include(typesOf(l), "MALFORMED_FOG_ENTRY");
	});
});

describe("validateMap — dangling frontier ref", () => {
	it("DANGLING_FRONTIER_REF when a frontier ticket names a non-sub-issue", () => {
		// #999 is on the frontier but not among the map's real sub-issues.
		const l = ledger({
			map: map({
				openFrontier: {
					present: true,
					entries: [{issue: 999, question: "#999 — Q?", founderDecisionFork: false}],
				},
			}),
			subIssues: [101, 102, 103, 104],
		});
		const defect = validateMap(l).find((d) => d.type === "DANGLING_FRONTIER_REF");
		assert.isDefined(defect);
		assert.deepStrictEqual(defect?.refs, [999]);
	});

	it("an empty sub-issue set disables the dangling check (graceful absence)", () => {
		const l = ledger({
			map: map({
				openFrontier: {
					present: true,
					entries: [{issue: 999, question: "#999 — Q?", founderDecisionFork: false}],
				},
			}),
			subIssues: [],
		});
		assert.notInclude(typesOf(l), "DANGLING_FRONTIER_REF");
	});
});

describe("validateMap — determinism", () => {
	it("emits defects in canonical rank order regardless of input", () => {
		const l = ledger({
			map: map({
				destination: {present: false, text: ""},
				openFrontier: {
					present: true,
					entries: [{issue: undefined, question: "no ref", founderDecisionFork: false}],
				},
			}),
		});
		const ranks = validateMap(l).map((d) => DEFECT_TYPES.indexOf(d.type));
		const sorted = [...ranks].sort((a, b) => a - b);
		assert.deepStrictEqual(ranks, sorted);
	});

	it("mapSignature is stable and omits messages", () => {
		const l = ledger({map: map({destination: {present: false, text: ""}})});
		assert.strictEqual(mapSignature(l), "MISSING_DESTINATION:100");
	});
});

describe("isGraduationReady + answerableFrontier", () => {
	it("not ready while an answerable (non-fork) frontier ticket remains", () => {
		const l = ledger();
		assert.strictEqual(isGraduationReady(l.map), false);
		assert.deepStrictEqual(
			answerableFrontier(l.map).map((t) => t.issue),
			[103],
		);
	});

	it("ready when the frontier holds only founder-decision-forks", () => {
		const m = map({
			openFrontier: {
				present: true,
				entries: [{issue: 104, question: "#104 — fork", founderDecisionFork: true}],
			},
		});
		assert.strictEqual(isGraduationReady(m), true);
		assert.deepStrictEqual(answerableFrontier(m), []);
	});

	it("ready when the frontier is empty", () => {
		const m = map({openFrontier: {present: true, entries: []}});
		assert.strictEqual(isGraduationReady(m), true);
	});

	it("a malformed (no-issue) frontier entry does not count as answerable", () => {
		const m = map({
			openFrontier: {
				present: true,
				entries: [{issue: undefined, question: "no ref", founderDecisionFork: false}],
			},
		});
		assert.strictEqual(isGraduationReady(m), true);
	});
});
