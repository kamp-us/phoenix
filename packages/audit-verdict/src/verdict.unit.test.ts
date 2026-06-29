/**
 * The pure verdict contract, pinned without IO (the founder-seed/preview-seed idiom):
 *   - the dated/comparable schema shape;
 *   - the per-dimension roll-up;
 *   - the story-11 rule — ANY dimension FAIL ⇒ overall FAIL;
 *   - the (dimension, check, surface) TRIPLE key (no cross-surface collision);
 *   - a two-run mechanical diff over the stable schema;
 *   - the repo-relative archive-path invariant.
 */
import {assert, describe, it} from "@effect/vitest";
import {archivePath, assertRepoRelative} from "./archive.ts";
import {renderVerdictJson, renderVerdictMarkdown} from "./render.ts";
import type {DimensionResult, Finding} from "./schema.ts";
import {buildVerdict, diffVerdicts, dimensionStatus, findingKey} from "./verdict.ts";

const finding = (
	over: Partial<Finding> & Pick<Finding, "dimension" | "check" | "surface" | "status">,
): Finding => ({
	expected: "expected",
	observed: "observed",
	evidence: "rite-audit/runs/evidence/shot.png",
	...over,
});

const DATE = "2026-06-28T12:00:00.000Z";
const target = {stage: "audit", baseUrl: "https://audit.example.workers.dev"};

const dim = (dimension: string, findings: Finding[]): DimensionResult => ({
	dimension,
	status: dimensionStatus(findings),
	findings,
});

describe("buildVerdict — dated, comparable schema shape", () => {
	it("emits one dated verdict with overall + per-dimension pass/fail for all three dimensions", () => {
		const v = buildVerdict({
			date: DATE,
			target,
			dimensions: [
				dim("functional-rite", [
					finding({
						dimension: "functional-rite",
						check: "vouch",
						surface: "/divan",
						status: "PASS",
					}),
				]),
				dim("accessibility", [
					finding({
						dimension: "accessibility",
						check: "contrast",
						surface: "/auth",
						status: "PASS",
					}),
				]),
				dim("sandbox-leak", [
					finding({
						dimension: "sandbox-leak",
						check: "feed-leak",
						surface: "/pano",
						status: "PASS",
					}),
				]),
			],
		});
		assert.strictEqual(v.date, DATE);
		assert.deepStrictEqual(v.target, target);
		assert.strictEqual(v.overall, "PASS");
		assert.deepStrictEqual(
			v.perDimension,
			[
				{dimension: "accessibility", status: "PASS"},
				{dimension: "functional-rite", status: "PASS"},
				{dimension: "sandbox-leak", status: "PASS"},
			],
			"per-dimension is sorted by id for stable comparison",
		);
	});

	it("is byte-stable for a fixed input regardless of dimension/finding input order", () => {
		const a = buildVerdict({
			date: DATE,
			target,
			dimensions: [
				dim("sandbox-leak", [
					finding({dimension: "sandbox-leak", check: "b", surface: "/y", status: "PASS"}),
				]),
				dim("accessibility", [
					finding({dimension: "accessibility", check: "a", surface: "/x", status: "PASS"}),
				]),
			],
		});
		const b = buildVerdict({
			date: DATE,
			target,
			dimensions: [
				dim("accessibility", [
					finding({dimension: "accessibility", check: "a", surface: "/x", status: "PASS"}),
				]),
				dim("sandbox-leak", [
					finding({dimension: "sandbox-leak", check: "b", surface: "/y", status: "PASS"}),
				]),
			],
		});
		assert.strictEqual(renderVerdictJson(a), renderVerdictJson(b));
	});
});

describe("dimensionStatus / overall — the story-11 rule", () => {
	it("a dimension is FAIL if any finding is FAIL", () => {
		assert.strictEqual(
			dimensionStatus([
				finding({dimension: "d", check: "ok", surface: "/a", status: "PASS"}),
				finding({dimension: "d", check: "bad", surface: "/b", status: "FAIL"}),
			]),
			"FAIL",
		);
	});

	it("a dimension is FAIL if any finding is BLOCKED (BLOCKED is never a pass)", () => {
		assert.strictEqual(
			dimensionStatus([finding({dimension: "d", check: "x", surface: "/a", status: "BLOCKED"})]),
			"FAIL",
		);
	});

	it("ANY dimension FAIL ⇒ overall FAIL — a regression is unmistakable", () => {
		const v = buildVerdict({
			date: DATE,
			target,
			dimensions: [
				dim("functional-rite", [
					finding({
						dimension: "functional-rite",
						check: "vouch",
						surface: "/divan",
						status: "PASS",
					}),
				]),
				dim("accessibility", [
					finding({
						dimension: "accessibility",
						check: "contrast",
						surface: "/auth",
						status: "FAIL",
					}),
				]),
				dim("sandbox-leak", [
					finding({
						dimension: "sandbox-leak",
						check: "feed-leak",
						surface: "/pano",
						status: "PASS",
					}),
				]),
			],
		});
		assert.strictEqual(v.overall, "FAIL");
		assert.deepStrictEqual(
			v.perDimension.find((d) => d.dimension === "accessibility"),
			{dimension: "accessibility", status: "FAIL"},
		);
	});

	it("recomputes the roll-up from findings — a mis-set DimensionResult.status cannot mask a FAIL", () => {
		const lying: DimensionResult = {
			dimension: "sandbox-leak",
			status: "PASS", // lies: a finding below is FAIL
			findings: [
				finding({dimension: "sandbox-leak", check: "leak", surface: "/u/x", status: "FAIL"}),
			],
		};
		const v = buildVerdict({date: DATE, target, dimensions: [lying]});
		assert.strictEqual(v.overall, "FAIL");
		assert.strictEqual(v.perDimension[0]?.status, "FAIL");
	});
});

describe("findingKey — the (dimension, check, surface) TRIPLE", () => {
	it("the same check on two surfaces does NOT collide (the triple, not the pair)", () => {
		const a = finding({
			dimension: "accessibility",
			check: "contrast",
			surface: "/auth",
			status: "FAIL",
		});
		const b = finding({
			dimension: "accessibility",
			check: "contrast",
			surface: "/divan",
			status: "PASS",
		});
		assert.notStrictEqual(findingKey(a), findingKey(b));
	});

	it("keeps both same-check-different-surface findings distinct through aggregation", () => {
		const v = buildVerdict({
			date: DATE,
			target,
			dimensions: [
				dim("accessibility", [
					finding({
						dimension: "accessibility",
						check: "contrast",
						surface: "/auth",
						status: "FAIL",
					}),
					finding({
						dimension: "accessibility",
						check: "contrast",
						surface: "/divan",
						status: "PASS",
					}),
				]),
			],
		});
		assert.strictEqual(v.findings.length, 2, "both surfaces survive — no collision");
		assert.strictEqual(new Set(v.findings.map(findingKey)).size, 2);
	});
});

describe("diffVerdicts — two dated runs diff mechanically over the stable schema", () => {
	const run1 = buildVerdict({
		date: "2026-06-27T00:00:00.000Z",
		target,
		dimensions: [
			dim("functional-rite", [
				finding({dimension: "functional-rite", check: "vouch", surface: "/divan", status: "PASS"}),
			]),
			dim("accessibility", [
				finding({dimension: "accessibility", check: "contrast", surface: "/auth", status: "PASS"}),
			]),
		],
	});
	const run2 = buildVerdict({
		date: "2026-06-28T00:00:00.000Z",
		target,
		dimensions: [
			dim("functional-rite", [
				finding({dimension: "functional-rite", check: "vouch", surface: "/divan", status: "PASS"}),
			]),
			dim("accessibility", [
				finding({dimension: "accessibility", check: "contrast", surface: "/auth", status: "FAIL"}),
			]),
		],
	});

	it("surfaces an overall regression PASS -> FAIL", () => {
		const diff = diffVerdicts(run1, run2);
		assert.deepStrictEqual(diff.overall, {from: "PASS", to: "FAIL", changed: true});
	});

	it("attributes the regression to the dimension that broke", () => {
		const diff = diffVerdicts(run1, run2);
		assert.deepStrictEqual(
			diff.perDimension.find((d) => d.dimension === "accessibility"),
			{dimension: "accessibility", change: "regressed", from: "PASS", to: "FAIL"},
		);
		assert.strictEqual(
			diff.perDimension.find((d) => d.dimension === "functional-rite")?.change,
			"unchanged",
		);
	});

	it("pins the regression to the exact (dimension, check, surface) finding", () => {
		const diff = diffVerdicts(run1, run2);
		const delta = diff.findings.find(
			(f) =>
				f.key.dimension === "accessibility" &&
				f.key.check === "contrast" &&
				f.key.surface === "/auth",
		);
		assert.deepStrictEqual(delta, {
			key: {dimension: "accessibility", check: "contrast", surface: "/auth"},
			change: "status-changed",
			from: "PASS",
			to: "FAIL",
		});
	});

	it("an identical re-run diffs to no change", () => {
		const diff = diffVerdicts(run1, run1);
		assert.isFalse(diff.overall.changed);
		assert.isTrue(diff.perDimension.every((d) => d.change === "unchanged"));
		assert.isTrue(diff.findings.every((f) => f.change === "unchanged"));
	});
});

describe("archivePath — repo-relative accumulating run log", () => {
	it("derives a repo-relative path under rite-audit/runs/", () => {
		const v = buildVerdict({date: DATE, target, dimensions: []});
		assert.strictEqual(archivePath(v, "json"), "rite-audit/runs/2026-06-28T120000Z-audit.json");
		assert.strictEqual(archivePath(v, "md"), "rite-audit/runs/2026-06-28T120000Z-audit.md");
	});

	it("refuses an absolute / home / escaping path (no leaked local paths in the artifact)", () => {
		assert.throws(() => assertRepoRelative("/Users/x/rite-audit/runs/r.json"));
		assert.throws(() => assertRepoRelative("~/rite-audit/r.json"));
		assert.throws(() => assertRepoRelative("../../etc/passwd"));
		assert.strictEqual(assertRepoRelative("rite-audit/runs/ok.json"), "rite-audit/runs/ok.json");
	});

	it("a hostile stage name cannot escape the run-log dir", () => {
		const v = buildVerdict({
			date: DATE,
			target: {stage: "../../evil", baseUrl: "x"},
			dimensions: [],
		});
		const p = archivePath(v, "json");
		assert.isFalse(p.split("/").includes(".."));
		assert.isTrue(p.startsWith("rite-audit/runs/"));
	});
});

describe("renderVerdictMarkdown — human-readable artifact with evidence", () => {
	it("includes the overall, the per-dimension table, and each failing finding's evidence", () => {
		const v = buildVerdict({
			date: DATE,
			target,
			dimensions: [
				dim("accessibility", [
					finding({
						dimension: "accessibility",
						check: "contrast",
						surface: "/auth",
						status: "FAIL",
						evidence: "rite-audit/runs/evidence/auth-contrast.png",
					}),
				]),
			],
		});
		const md = renderVerdictMarkdown(v);
		assert.include(md, "rite-audit verdict — FAIL");
		assert.include(md, "| `accessibility` | FAIL |");
		assert.include(md, "rite-audit/runs/evidence/auth-contrast.png");
	});
});
