/**
 * The `path-filter-guard` rule — the `path-filter-guard.unit.test.ts` cases from `pipeline-cli`.
 *
 * The basis cases are the ones the #3722 defect needed: byte-identical globs passed the pre-#3722
 * guard while the two steps read two different changed-file sets, so equality of the LISTS is
 * asserted separately from equality of the `(token, base)` pair, and both are proven to red alone.
 */
import {describe, expect, it} from "vitest";
import {
	CI_E2E_SOURCE,
	describeBasis,
	extractFilterList,
	judge,
	renderReport,
} from "./path-filter.ts";

const workflow = (
	key: string,
	globs: ReadonlyArray<string>,
	inputs = "          token: ''\n",
): string =>
	`
jobs:
  changes:
    steps:
      - uses: dorny/paths-filter@v3.0.2
        with:
${inputs}          filters: |
            ${key}:
${globs.map((g) => `              - '${g}'`).join("\n")}
`;

const GLOBS = ["apps/web/**", "packages/**"];

describe("judge", () => {
	it("passes identical glob sets read against the same basis", () => {
		expect(judge({ciText: workflow("e2e", GLOBS), deployText: workflow("deploy", GLOBS)})).toEqual({
			pass: true,
			count: 2,
		});
	});

	// Set equality, not list equality: the two files order their globs for human reading.
	it("passes the same set in a different order", () => {
		expect(
			judge({ciText: workflow("e2e", GLOBS), deployText: workflow("deploy", [...GLOBS].reverse())}),
		).toMatchObject({pass: true});
	});

	it("names both directions of a drift", () => {
		const verdict = judge({
			ciText: workflow("e2e", ["a/**", "b/**"]),
			deployText: workflow("deploy", ["a/**", "c/**"]),
		});
		expect(verdict).toMatchObject({
			pass: false,
			reason: "drift",
			onlyInE2e: ["b/**"],
			onlyInDeploy: ["c/**"],
		});
	});

	// The #3722 defect verbatim: equal lists, unequal readers. The pre-fix guard passed this.
	it("reds equal globs read against a different token", () => {
		expect(
			judge({
				ciText: workflow("e2e", GLOBS, "          token: ''\n"),
				deployText: workflow("deploy", GLOBS, "          token: abc\n"),
			}),
		).toMatchObject({pass: false, reason: "basis-drift"});
	});

	it("reds equal globs read from a different base", () => {
		expect(
			judge({
				ciText: workflow("e2e", GLOBS, "          token: ''\n          base: main\n"),
				deployText: workflow("deploy", GLOBS, "          token: ''\n"),
			}),
		).toMatchObject({pass: false, reason: "basis-drift"});
	});

	it.each([
		["no jobs", "name: ci\n"],
		["no changes job", "jobs:\n  other:\n    steps: []\n"],
		["no dorny step", "jobs:\n  changes:\n    steps:\n      - run: echo\n"],
		["a missing key", workflow("other", GLOBS)],
		[
			"an empty list",
			"jobs:\n  changes:\n    steps:\n      - uses: dorny/paths-filter@v3\n        with:\n          filters: |\n            e2e: []\n",
		],
	])("fails closed on zero scope: %s", (_name, ciText) => {
		expect(judge({ciText, deployText: workflow("deploy", GLOBS)})).toMatchObject({
			pass: false,
			reason: "zero-scope",
		});
	});
});

describe("extractFilterList", () => {
	it("reads an absent token as absent rather than as empty", () => {
		const extraction = extractFilterList(
			workflow("e2e", GLOBS, "          base: main\n"),
			CI_E2E_SOURCE,
		);
		expect(extraction).toMatchObject({ok: true, basis: {token: undefined, base: "main"}});
	});
});

describe("describeBasis", () => {
	it("names the mode each token value selects", () => {
		expect(describeBasis({token: undefined, base: undefined})).toContain("API/listFiles mode");
		expect(describeBasis({token: "", base: undefined})).toContain("API-free git-diff mode");
	});
});

describe("renderReport", () => {
	it("names the wedged-poll consequence on a drift", () => {
		const report = renderReport(
			judge({ciText: workflow("e2e", ["a/**"]), deployText: workflow("deploy", ["b/**"])}),
		);
		expect(report).toContain("#2372");
		expect(report).toContain("ONLY in ci.yml changes.e2e");
	});
});
