import {describe, expect, it} from "vitest";
import {gateCoverageOf, inspectsHead, isRepoAuthored, type RunProvenance} from "./gate-coverage.ts";

const CI = ".github/workflows/ci.yml";
const GUARD = ".github/workflows/migrations-guard.yml";
const CLEANUP = ".github/workflows/pr-cleanup.yml";
const CODEQL = "dynamic/github-code-scanning/codeql";
const DEPENDABOT = "dynamic/dependabot/dependabot-updates";

const HEAD = "00dec4c9636f27d23d45029557fab9d12fe4ee07";
const OTHER = "5f1e2d3c4b5a69788796a5b4c3d2e1f009182736";

/** A run that opened the head — the shape every coverage case turns one field of. */
const ran = (path: string, shape: Partial<RunProvenance> = {}): RunProvenance => ({
	path,
	event: "pull_request",
	headSha: HEAD,
	...shape,
});

describe("isRepoAuthored", () => {
	it("reads a workflow file checked into the repo as repo-authored", () => {
		expect(isRepoAuthored(CI)).toBe(true);
	});

	it("reads a platform-provided workflow as not repo-authored", () => {
		expect(isRepoAuthored(CODEQL)).toBe(false);
		expect(isRepoAuthored(DEPENDABOT)).toBe(false);
	});
});

describe("inspectsHead", () => {
	it("reads a pull_request run at the head as having opened it", () => {
		expect(inspectsHead(ran(CI), HEAD)).toBe(true);
	});

	it("refuses a pull_request_target run — it carries the head and checks out the base", () => {
		expect(inspectsHead(ran(CLEANUP, {event: "pull_request_target"}), HEAD)).toBe(false);
	});

	it("keeps the exact-head workflow_dispatch release path — the event is not the filter", () => {
		expect(inspectsHead(ran(CI, {event: "workflow_dispatch"}), HEAD)).toBe(true);
		expect(inspectsHead(ran(CI, {event: "push"}), HEAD)).toBe(true);
	});

	it("refuses a run that carries another commit", () => {
		expect(inspectsHead(ran(CI, {headSha: OTHER}), HEAD)).toBe(false);
	});
});

describe("gateCoverageOf", () => {
	it("covers a head where one of the repo's own workflows ran", () => {
		expect(gateCoverageOf([CI, GUARD, CODEQL], [ran(CI), ran(CODEQL)], HEAD)).toEqual({
			_tag: "Covered",
			declared: 2,
			covered: 1,
		});
	});

	it("leaves a CodeQL-only head uncovered — the #6522 shape", () => {
		expect(gateCoverageOf([CI, GUARD, CODEQL], [ran(CODEQL), ran(CODEQL)], HEAD)).toEqual({
			_tag: "Uncovered",
			declared: 2,
		});
	});

	it("leaves a head whose only repo-authored run is the base-context cleanup uncovered", () => {
		// The reported incident, at its own commit: `pr-cleanup.yml` is checked into the repo and runs on
		// `pull_request_target`, so it sits at the head having opened the base. A conflicted PR gets no
		// `pull_request` run at all, which leaves that one run as the whole evidence for a `green`.
		expect(
			gateCoverageOf([CI, GUARD, CLEANUP], [ran(CLEANUP, {event: "pull_request_target"})], HEAD),
		).toEqual({_tag: "Uncovered", declared: 3});
	});

	it("covers a mixed head off the valid run beside the cleanup one", () => {
		expect(
			gateCoverageOf(
				[CI, GUARD, CLEANUP],
				[ran(CLEANUP, {event: "pull_request_target"}), ran(CI)],
				HEAD,
			),
		).toEqual({_tag: "Covered", declared: 3, covered: 1});
	});

	it("leaves a head uncovered when its repo-authored run carries another commit", () => {
		expect(gateCoverageOf([CI], [ran(CI, {headSha: OTHER})], HEAD)).toEqual({
			_tag: "Uncovered",
			declared: 1,
		});
	});

	it("cannot judge an unresolved head, and says so rather than calling it uncovered", () => {
		const answer = gateCoverageOf([CI], [ran(CI)], "00dec4c9");
		expect(answer._tag).toBe("Unreadable");
	});

	it("leaves a head with no runs at all uncovered", () => {
		expect(gateCoverageOf([CI], [], HEAD)).toEqual({_tag: "Uncovered", declared: 1});
	});

	it("has no gate to miss when the repo authors none", () => {
		expect(gateCoverageOf([CODEQL, DEPENDABOT], [ran(CODEQL)], HEAD)).toEqual({_tag: "NoGates"});
		expect(gateCoverageOf([], [], HEAD)).toEqual({_tag: "NoGates"});
	});

	it("counts a workflow that ran twice at the head once", () => {
		expect(gateCoverageOf([CI, GUARD], [ran(CI), ran(CI), ran(CI)], HEAD)).toEqual({
			_tag: "Covered",
			declared: 2,
			covered: 1,
		});
	});

	it("ignores a run whose workflow the live inventory no longer carries", () => {
		// A deleted workflow's old run still sits at the head. It proves nothing about the gates the
		// repo has now, which is the only set a reviewer is asking about.
		expect(gateCoverageOf([CI], [ran(".github/workflows/deleted.yml")], HEAD)).toEqual({
			_tag: "Uncovered",
			declared: 1,
		});
	});
});
