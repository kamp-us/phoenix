/**
 * The pure `change-detect-guard` verdict (#3245), over crafted ci.yml text — no disk. The
 * IO exit-code gate is crossed in `gate.unit.test.ts`; here the decision itself is proven:
 * `token: ''` passes, an explicit non-empty token fails (api-mode), an absent `token:` fails
 * (api-mode, the `${{ github.token }}` default), and every structural gap fails closed.
 *
 * This is the transient-blip regression test: the flake fires ONLY through dorny's GitHub-API
 * read path, which is selected by a set/defaulted token — so proving the guard reds on any
 * token that reopens that path proves the #3244/#3245 flake surface stays closed.
 */
import {describe, expect, it} from "@effect/vitest";
import {judge} from "./change-detect-guard.ts";

/**
 * Build a ci.yml with a `changes` job whose dorny/paths-filter step carries the given
 * `with:` lines. Indentation matches ci.yml: step at 6 spaces, `with:` keys at 10.
 */
const mkCi = (withLines: ReadonlyArray<string>): string =>
	[
		"name: CI",
		"on:",
		"  pull_request:",
		"jobs:",
		"  changes:",
		"    runs-on: ubuntu-latest",
		"    steps:",
		"      - uses: actions/checkout@v4.2.2",
		"        with:",
		"          fetch-depth: 0",
		"      - uses: dorny/paths-filter@v3.0.2",
		"        id: filter",
		"        with:",
		...withLines.map((l) => `          ${l}`),
		"",
	].join("\n");

describe("judge — the API-free git-mode invariant on ci.yml's changes job", () => {
	it("PASSES when the dorny step sets token: '' (single-quoted empty)", () => {
		const ci = mkCi(["token: ''", "filters: |", "  code:", "    - 'packages/**'"]);
		expect(judge(ci)).toEqual({pass: true});
	});

	it('PASSES when the dorny step sets token: "" (double-quoted empty)', () => {
		const ci = mkCi(['token: ""', "filters: |", "  code:", "    - 'packages/**'"]);
		expect(judge(ci)).toEqual({pass: true});
	});

	it("FAILS (api-mode) when the dorny step sets an explicit github.token", () => {
		const ci = mkCi(["token: ${{ github.token }}", "filters: |", "  code:", "    - 'packages/**'"]);
		expect(judge(ci)).toMatchObject({pass: false, reason: "api-mode"});
	});

	it("FAILS (api-mode) when the dorny step omits token entirely (defaults to github.token)", () => {
		const ci = mkCi(["filters: |", "  code:", "    - 'packages/**'"]);
		expect(judge(ci)).toMatchObject({pass: false, reason: "api-mode"});
	});

	it("FAILS (api-mode) when token is null (bare `token:` → action.yml default)", () => {
		const ci = mkCi(["token:", "filters: |", "  code:", "    - 'packages/**'"]);
		expect(judge(ci)).toMatchObject({pass: false, reason: "api-mode"});
	});

	it("FAILS (zero-scope) when there is no dorny/paths-filter step", () => {
		const ci = mkCi(["token: ''"]).replace(
			"      - uses: dorny/paths-filter@v3.0.2",
			"      - uses: some/other-action@v1",
		);
		expect(judge(ci)).toMatchObject({pass: false, reason: "zero-scope"});
	});

	it("FAILS (zero-scope) when the changes job is missing", () => {
		const ci = mkCi(["token: ''", "filters: |", "  code:", "    - 'packages/**'"]).replace(
			"  changes:",
			"  other:",
		);
		expect(judge(ci)).toMatchObject({pass: false, reason: "zero-scope"});
	});

	it("FAILS (zero-scope) on unparseable ci.yml", () => {
		expect(judge("name: [unterminated\n")).toMatchObject({pass: false, reason: "zero-scope"});
	});

	it("FAILS (zero-scope) when the dorny step has no with: block", () => {
		const ci = [
			"name: CI",
			"on:",
			"  pull_request:",
			"jobs:",
			"  changes:",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - uses: dorny/paths-filter@v3.0.2",
			"        id: filter",
			"",
		].join("\n");
		expect(judge(ci)).toMatchObject({pass: false, reason: "zero-scope"});
	});
});
