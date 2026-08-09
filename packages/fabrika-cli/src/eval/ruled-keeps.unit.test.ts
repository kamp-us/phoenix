import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import type {IncidentProvenance} from "./incident-provenance.ts";
import {
	decodeRuledKeeps,
	publishedFigure,
	publishedFigureViolations,
	type RuledKeeps,
	renderKeeps,
	ruledKeepsViolations,
	summarize,
	withCoverage,
} from "./ruled-keeps.ts";

const snapshot = {at: "2026-08-03", state: "open" as const, milestone: "M37"};

const member = (issue: number, over: Record<string, unknown> = {}) => ({
	issue,
	title: `issue ${issue}`,
	sweepVerdict: "KEEP-AS-EVAL",
	sweepReason: "an observed incident",
	sweepSection: "M37 Worktree-Isolation Integrity",
	borderline: false,
	status: "member",
	snapshot,
	...over,
});

const file = (rows: ReadonlyArray<unknown>) => ({
	corpus: "test corpus",
	derivedAt: "2026-08-03",
	derivation: {recipe: "a recipe", sources: ["#4634"], arithmetic: ["1 + 1 = 2"]},
	rows,
});

const decode = (value: unknown): RuledKeeps => {
	const result = decodeRuledKeeps(JSON.stringify(value));
	assert.isTrue(Result.isSuccess(result), "fixture must decode");
	if (!Result.isSuccess(result)) throw new Error("unreachable");
	return result.success;
};

describe("decodeRuledKeeps", () => {
	it("is total on malformed JSON", () => {
		const result = decodeRuledKeeps("{not json");
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "malformed-json");
	});

	it("refuses a pending row with no reason — the union makes it unrepresentable", () => {
		const result = decodeRuledKeeps(JSON.stringify(file([{...member(4180), status: "pending"}])));
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "schema-mismatch");
	});

	it("refuses a snapshot state outside open/closed", () => {
		const result = decodeRuledKeeps(
			JSON.stringify(file([member(1, {snapshot: {...snapshot, state: "merged"}})])),
		);
		assert.isTrue(Result.isFailure(result));
	});
});

describe("ruledKeepsViolations", () => {
	it("holds on a well-formed enumeration", () => {
		assert.deepStrictEqual(ruledKeepsViolations(decode(file([member(1)]))), []);
	});

	it("names a member row that never carried the KEEP-AS-EVAL verdict", () => {
		const violations = ruledKeepsViolations(
			decode(file([member(7, {sweepVerdict: "KILL-CANDIDATE"})])),
		);
		assert.deepStrictEqual(violations, [
			"#7: member row carries sweep verdict 'KILL-CANDIDATE', not KEEP-AS-EVAL",
		]);
	});

	it("names a duplicated issue", () => {
		const violations = ruledKeepsViolations(decode(file([member(1), member(1)])));
		assert.include(violations, "#1: duplicate row");
	});

	it("names a pending row whose reason is blank", () => {
		const violations = ruledKeepsViolations(
			decode(file([{...member(4180), status: "pending", pendingReason: "   "}])),
		);
		assert.include(violations, "#4180: pending row records no reason");
	});

	it("reds on an empty enumeration rather than reporting green over nothing", () => {
		assert.include(
			ruledKeepsViolations(decode(file([]))),
			"enumeration is empty — zero scope reds (ADR 0092)",
		);
	});

	it("reds when the derivation cites nothing, so the list cannot be asserted unaudited", () => {
		const bare = {...file([member(1)]), derivation: {recipe: "", sources: [], arithmetic: []}};
		const violations = ruledKeepsViolations(decode(bare));
		assert.deepStrictEqual(violations, [
			"derivation records no recipe",
			"derivation cites no source artifact",
			"derivation shows no arithmetic",
		]);
	});
});

const ledger = (
	cases: ReadonlyArray<{id: number; incidents: ReadonlyArray<string>}>,
): IncidentProvenance => ({
	corpus: "test",
	cases: cases.map((c) => ({
		tier: "deterministic",
		id: c.id,
		title: `case ${c.id}`,
		incidents: c.incidents,
		verification: ["verified"],
		corrections: [],
	})),
	declined: [],
});

describe("withCoverage", () => {
	it("joins each row to the cases that cite it", () => {
		const covered = withCoverage(
			decode(file([member(10), member(20)])),
			ledger([
				{id: 1, incidents: ["#10", "#99"]},
				{id: 2, incidents: ["#10"]},
			]),
		);
		assert.deepStrictEqual(
			covered.map((c) => [c.row.issue, c.pinnedBy]),
			[
				[10, [1, 2]],
				[20, []],
			],
		);
	});

	it("does not match a prefix — #10 is not pinned by a case citing #100", () => {
		const covered = withCoverage(
			decode(file([member(10)])),
			ledger([{id: 1, incidents: ["#100"]}]),
		);
		assert.deepStrictEqual(covered[0]?.pinnedBy, []);
	});
});

describe("summarize", () => {
	it("counts members, pending, borderline and coverage separately", () => {
		const keeps = decode(
			file([
				member(1),
				member(2, {borderline: true}),
				{...member(3), status: "pending", pendingReason: "retracted"},
			]),
		);
		assert.deepStrictEqual(summarize(withCoverage(keeps, ledger([{id: 1, incidents: ["#1"]}]))), {
			members: 2,
			pending: 1,
			borderline: 1,
			covered: 1,
			uncovered: 1,
		});
	});
});

describe("publishedFigure", () => {
	it("is computed from the rows, so it moves when membership moves", () => {
		const one = decode(file([member(1)]));
		const two = decode(
			file([
				member(1),
				member(2),
				{...member(4180), status: "pending", pendingReason: "retracted"},
			]),
		);
		assert.strictEqual(publishedFigure(one), "1 members plus 0 pending");
		assert.strictEqual(publishedFigure(two), "2 members plus 1 pending");
	});
});

describe("publishedFigureViolations", () => {
	const figure = "66 members plus 1 pending";

	it("holds on a surface that publishes the derived figure and no discredited one", () => {
		assert.deepStrictEqual(
			publishedFigureViolations("doc.md", `The corpus is ${figure} today.`, figure),
			[],
		);
	});

	it("reds when the surface publishes a figure the enumeration no longer supports", () => {
		const violations = publishedFigureViolations(
			"doc.md",
			"The corpus is 65 members plus 2 pending today.",
			figure,
		);
		assert.deepStrictEqual(violations, [
			"doc.md: does not publish the enumerated figure '66 members plus 1 pending'",
		]);
	});

	it("reds on a copy of the discredited cardinality even beside the right figure", () => {
		const violations = publishedFigureViolations(
			"doc.md",
			`Pull rows from the 74-issue KEEP corpus. The corpus is ${figure}.`,
			figure,
		);
		assert.deepStrictEqual(violations, ["doc.md: asserts the discredited '74-issue KEEP corpus'"]);
	});

	it("does not red on the ruling's size being narrated as superseded history", () => {
		const text = `#4642 published its size as 74; the enumeration says ${figure}.`;
		assert.deepStrictEqual(publishedFigureViolations("doc.md", text, figure), []);
	});
});

describe("renderKeeps", () => {
	it("marks a pending row and names the case that pins a covered one", () => {
		const keeps = decode(
			file([member(1), {...member(4180), status: "pending", pendingReason: "retracted"}]),
		);
		const text = renderKeeps(keeps, withCoverage(keeps, ledger([{id: 9, incidents: ["#1"]}])));
		assert.include(text, "#1 [pinned by case 9]");
		assert.include(text, "#4180 [PENDING · no case]");
		assert.include(text, "pending: retracted");
		assert.include(text, "1 member(s) plus 1 pending");
	});
});
