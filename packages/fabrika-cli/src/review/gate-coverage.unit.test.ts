import {describe, expect, it} from "vitest";
import {gateCoverageOf, isRepoAuthored} from "./gate-coverage.ts";

const CI = ".github/workflows/ci.yml";
const GUARD = ".github/workflows/migrations-guard.yml";
const CODEQL = "dynamic/github-code-scanning/codeql";
const DEPENDABOT = "dynamic/dependabot/dependabot-updates";

describe("isRepoAuthored", () => {
	it("reads a workflow file checked into the repo as repo-authored", () => {
		expect(isRepoAuthored(CI)).toBe(true);
	});

	it("reads a platform-provided workflow as not repo-authored", () => {
		expect(isRepoAuthored(CODEQL)).toBe(false);
		expect(isRepoAuthored(DEPENDABOT)).toBe(false);
	});
});

describe("gateCoverageOf", () => {
	it("covers a head where one of the repo's own workflows ran", () => {
		expect(gateCoverageOf([CI, GUARD, CODEQL], [CI, CODEQL])).toEqual({
			_tag: "Covered",
			declared: 2,
			covered: 1,
		});
	});

	it("leaves a CodeQL-only head uncovered — the #6522 shape", () => {
		expect(gateCoverageOf([CI, GUARD, CODEQL], [CODEQL, CODEQL])).toEqual({
			_tag: "Uncovered",
			declared: 2,
		});
	});

	it("leaves a head with no runs at all uncovered", () => {
		expect(gateCoverageOf([CI], [])).toEqual({_tag: "Uncovered", declared: 1});
	});

	it("has no gate to miss when the repo authors none", () => {
		expect(gateCoverageOf([CODEQL, DEPENDABOT], [CODEQL])).toEqual({_tag: "NoGates"});
		expect(gateCoverageOf([], [])).toEqual({_tag: "NoGates"});
	});

	it("counts a workflow that ran twice at the head once", () => {
		expect(gateCoverageOf([CI, GUARD], [CI, CI, CI])).toEqual({
			_tag: "Covered",
			declared: 2,
			covered: 1,
		});
	});

	it("ignores a run whose workflow the live inventory no longer carries", () => {
		// A deleted workflow's old run still sits at the head. It proves nothing about the gates the
		// repo has now, which is the only set a reviewer is asking about.
		expect(gateCoverageOf([CI], [".github/workflows/deleted.yml"])).toEqual({
			_tag: "Uncovered",
			declared: 1,
		});
	});
});
