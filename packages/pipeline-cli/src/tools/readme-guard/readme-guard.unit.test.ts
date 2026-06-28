/**
 * Pure-core tests for `readme-guard` (#938/#939): the dead-shell-ignoring scope,
 * the fail-closed-on-zero verdict (ADR 0092), and the workspace-glob parse. No IO —
 * the filesystem seam is crossed in `gate.unit.test.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	judge,
	type PackageDirCandidate,
	parseWorkspacePackageGlobs,
	renderReport,
} from "./readme-guard.ts";

const candidate = (
	dir: string,
	hasPackageJson: boolean,
	hasReadme: boolean,
): PackageDirCandidate => ({dir, hasPackageJson, hasReadme});

describe("judge — scope to real workspace members (package.json-bearing dirs)", () => {
	it("PASSES when every package.json-bearing member has a README", () => {
		const verdict = judge([
			candidate("packages/a", true, true),
			candidate("packages/b", true, true),
		]);
		expect(verdict.pass).toBe(true);
		expect(verdict.pass && verdict.members).toEqual(["packages/a", "packages/b"]);
	});

	it("IGNORES dead-shell dirs (no package.json) — never reds on them", () => {
		const verdict = judge([
			candidate("packages/real", true, true),
			// dead shells: no package.json, no README — must be filtered out, not failed on
			candidate("packages/leak-guard", false, false),
			candidate("packages/spawn-guard", false, false),
		]);
		expect(verdict.pass).toBe(true);
		expect(verdict.pass && verdict.members).toEqual(["packages/real"]);
	});

	it("FAILS missing-readme for a real member lacking a README, listing only real members", () => {
		const verdict = judge([
			candidate("packages/has-readme", true, true),
			candidate("packages/no-readme", true, false),
			candidate("packages/dead-shell", false, false),
		]);
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason).toBe("missing-readme");
		if (verdict.pass === false && verdict.reason === "missing-readme") {
			expect(verdict.missing).toEqual(["packages/no-readme"]);
			expect(verdict.members).toEqual(["packages/has-readme", "packages/no-readme"]);
		}
	});

	it("FAILS zero-scope (fail-closed, ADR 0092) when no member has a package.json", () => {
		const verdict = judge([
			candidate("packages/dead-a", false, false),
			candidate("packages/dead-b", false, true),
		]);
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason).toBe("zero-scope");
	});

	it("FAILS zero-scope on an empty candidate list", () => {
		const verdict = judge([]);
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason).toBe("zero-scope");
	});
});

describe("renderReport", () => {
	it("names every missing member on a missing-readme fail", () => {
		const report = renderReport(
			judge([candidate("packages/x", true, false), candidate("packages/y", true, false)]),
		);
		expect(report).toContain("packages/x");
		expect(report).toContain("packages/y");
		expect(report).toContain("2 packages/* workspace members lack a README.md");
	});

	it("explains the fail-closed zero-scope verdict", () => {
		const report = renderReport(judge([candidate("packages/dead", false, false)]));
		expect(report).toContain("ZERO");
		expect(report).toContain("fail-closed");
	});
});

describe("parseWorkspacePackageGlobs", () => {
	it("extracts the packages: sequence globs and stops at the next top-level key", () => {
		const yaml = [
			"packages:",
			"  - packages/*",
			"  - apps/*",
			"  - infra/*",
			"",
			"catalog:",
			"  effect: 1.2.3",
			"  - not-a-glob",
		].join("\n");
		expect(parseWorkspacePackageGlobs(yaml)).toEqual(["packages/*", "apps/*", "infra/*"]);
	});

	it("strips surrounding quotes from a glob", () => {
		expect(parseWorkspacePackageGlobs("packages:\n  - 'packages/*'\n")).toEqual(["packages/*"]);
	});

	it("returns [] when there is no packages: block", () => {
		expect(parseWorkspacePackageGlobs("catalog:\n  effect: 1\n")).toEqual([]);
	});
});
