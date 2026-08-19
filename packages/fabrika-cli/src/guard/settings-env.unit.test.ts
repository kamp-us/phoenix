/**
 * The pure rule behind `guard settings-env-guard check`, ported from the v1 CLI's
 * `settings-env-guard.unit.test.ts` (#2495). The cases carried across are the two real regression
 * values and the shape boundary — braced expands, bare `$VAR` does not.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the unexpanded brace token is the fixture under test; every case here must spell one in a plain string.
import {describe, expect, it} from "vitest";
import {envEntries, expansionReport, literalExpansions} from "./settings-env.ts";

const VERB = "guard settings-env-guard check";

describe("literalExpansions", () => {
	it("passes values with no brace token", () => {
		expect(literalExpansions([{key: "A", value: "/usr/bin"}])).toEqual([]);
	});

	// The whole block was scanned and held nothing to expand — a real pass, not a vacuous green.
	it("passes an empty env block", () => {
		expect(literalExpansions([])).toEqual([]);
	});

	it("flags the #2495 data-dir value", () => {
		const entry = {key: "KAMPUS_PIPELINE_DATA", value: "${CLAUDE_PROJECT_DIR}/.pipeline"};
		expect(literalExpansions([entry])).toEqual([entry]);
	});

	it("flags a brace token anywhere in the value, not only at the start", () => {
		const entry = {key: "PATH", value: "/opt/shim:${PATH}"};
		expect(literalExpansions([entry])).toEqual([entry]);
	});

	// Only the braced form is the verbatim-expansion trap the incident turned on.
	it("leaves a bare unbraced $VAR alone", () => {
		expect(literalExpansions([{key: "PATH", value: "/opt/shim:$PATH"}])).toEqual([]);
	});

	it("lists only the offenders, leaving clean entries out", () => {
		const flagged = {key: "BAD", value: "${X}"};
		expect(literalExpansions([{key: "OK", value: "1"}, flagged])).toEqual([flagged]);
	});
});

describe("envEntries", () => {
	it("reads the string-valued members of the env block", () => {
		expect(envEntries({env: {A: "1", B: "2"}})).toEqual([
			{key: "A", value: "1"},
			{key: "B", value: "2"},
		]);
	});

	// A non-string value never reaches the harness as one, so coercing it would invent bytes to scan.
	it("drops a non-string value rather than stringifying it", () => {
		expect(envEntries({env: {A: 1, B: "2"}})).toEqual([{key: "B", value: "2"}]);
	});

	it("reads no entries from a settings file with no env block", () => {
		expect(envEntries({permissions: {}})).toEqual([]);
		expect(envEntries(null)).toEqual([]);
		expect(envEntries("not an object")).toEqual([]);
	});
});

describe("expansionReport", () => {
	it("names each offender key = value and states the verbatim-env root cause", () => {
		const report = expansionReport(VERB, [{key: "KAMPUS_PIPELINE_DATA", value: "${X}/.pipeline"}]);
		expect(report).toContain("KAMPUS_PIPELINE_DATA = ${X}/.pipeline");
		expect(report).toContain("VERBATIM");
		expect(report).toContain("#2495");
	});
});
