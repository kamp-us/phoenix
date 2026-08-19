/**
 * The `change-detect-guard` rule — the `change-detect-guard.unit.test.ts` cases from `pipeline-cli`.
 *
 * The absent-`token:` case is the one that matters most and reads as the least alarming: dorny
 * DEFAULTS the input, so "no token" and "the API token" are the same thing to the action.
 */
import {describe, expect, it} from "vitest";
import {judge, renderReport} from "./change-detect.ts";

const ci = (step: string): string => `
name: ci
on: [pull_request]
jobs:
  changes:
    runs-on: ubuntu-latest
    steps:
${step}
`;

const dorny = (withBlock: string): string =>
	`      - uses: dorny/paths-filter@v3.0.2\n        with:\n${withBlock}`;

describe("judge", () => {
	it("passes when the dorny step pins an empty token", () => {
		expect(
			judge(
				ci(dorny("          token: ''\n          filters: |\n            a:\n              - x")),
			),
		).toEqual({
			pass: true,
		});
	});

	it("reds an absent token, which the action defaults to the API path", () => {
		const verdict = judge(ci(dorny("          filters: |\n            a:\n              - x")));
		expect(verdict).toMatchObject({pass: false, reason: "api-mode"});
	});

	it("reds an explicitly set token", () => {
		const verdict = judge(ci(dorny("          token: abc123\n          filters: 'a: x'")));
		expect(verdict).toMatchObject({pass: false, reason: "api-mode"});
	});

	// `@actions/core` getInput trims, so this is the value dorny's `if (token)` branch actually sees.
	it("passes a whitespace-only token, matching getInput's trimming", () => {
		expect(judge(ci(dorny("          token: '   '\n          filters: 'a: x'")))).toEqual({
			pass: true,
		});
	});

	it("reds a non-string token rather than reading it as empty", () => {
		expect(judge(ci(dorny("          token: 0\n          filters: 'a: x'")))).toMatchObject({
			pass: false,
			reason: "api-mode",
		});
	});

	it.each([
		["unparseable YAML", "\tnot: [valid"],
		["no jobs mapping", "name: ci\non: [pull_request]\n"],
		["no changes job", "jobs:\n  other:\n    steps: []\n"],
		["no dorny step", ci("      - run: echo hi")],
		["a dorny step with no with block", ci("      - uses: dorny/paths-filter@v3.0.2")],
	])("fails closed on zero scope: %s", (_name, text) => {
		expect(judge(text)).toMatchObject({pass: false, reason: "zero-scope"});
	});
});

describe("renderReport", () => {
	it("names the flake the api-mode red reopens", () => {
		const report = renderReport(judge(ci(dorny("          filters: 'a: x'"))));
		expect(report).toContain("#3244");
		expect(report).toContain("token: ''");
	});

	it("says fail-closed on a zero-scope red rather than reporting clean", () => {
		expect(renderReport(judge("jobs: {}"))).toContain("fail-closed");
	});
});
