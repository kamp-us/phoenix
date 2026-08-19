/**
 * The `design-token-guard` rule and its CSS parsers — the `design-token-guard.unit.test.ts` cases
 * from `pipeline-cli`.
 */
import {describe, expect, it} from "vitest";
import {
	type CssFileFacts,
	type DesignTokenConfig,
	judge,
	parseDeclaredProperties,
	parseHexLiterals,
	parseRawPxOverTwo,
	parseVarReferences,
	renderReport,
	stripCssComments,
} from "./design-token.ts";

const emptyConfig: DesignTokenConfig = {
	externalProperties: [],
	grandfatheredMissingTokens: [],
	rawPxCeilings: {},
};

const file = (over: Partial<CssFileFacts> & {path: string}): CssFileFacts => ({
	isRawLayer: false,
	declared: [],
	varRefs: [],
	hexLiterals: [],
	rawPx: [],
	...over,
});

describe("judge", () => {
	it("passes a file whose refs all resolve", () => {
		const facts = {
			files: [file({path: "a.css", declared: ["--x"], varRefs: [{name: "--x", line: 1}]})],
			config: emptyConfig,
		};
		expect(judge(facts)).toEqual({pass: true, filesChecked: 1, varRefsChecked: 1});
	});

	// The cascade is corpus-wide, so a ref resolves against a declaration in any file.
	it("resolves a ref against a declaration in another file", () => {
		expect(
			judge({
				files: [
					file({path: "tokens.css", declared: ["--x"], isRawLayer: true}),
					file({path: "a.css", varRefs: [{name: "--x", line: 1}]}),
				],
				config: emptyConfig,
			}),
		).toMatchObject({pass: true});
	});

	it("reds a dead ref — the #2167 class", () => {
		expect(
			judge({
				files: [file({path: "a.css", varRefs: [{name: "--gone", line: 4}]})],
				config: emptyConfig,
			}),
		).toMatchObject({
			pass: false,
			reason: "violations",
			undefinedRefs: [{path: "a.css", name: "--gone", line: 4}],
		});
	});

	it.each([
		["externalProperties", {...emptyConfig, externalProperties: ["--injected"]}],
		["grandfatheredMissingTokens", {...emptyConfig, grandfatheredMissingTokens: ["--injected"]}],
	])("admits a ref named in %s", (_name, config) => {
		expect(
			judge({files: [file({path: "a.css", varRefs: [{name: "--injected", line: 1}]})], config}),
		).toMatchObject({pass: true});
	});

	it("reds a hex outside the raw layer and allows one inside it", () => {
		expect(
			judge({
				files: [
					file({path: "a.css", hexLiterals: [{value: "#fff", line: 2}]}),
					file({path: "tokens.css", isRawLayer: true, hexLiterals: [{value: "#000", line: 1}]}),
				],
				config: emptyConfig,
			}),
		).toMatchObject({pass: false, hex: [{path: "a.css", value: "#fff", line: 2}]});
	});

	it("reds a file over its ceiling and passes one at it", () => {
		const px = [
			{value: "8px", line: 1},
			{value: "12px", line: 2},
		];
		const config = {...emptyConfig, rawPxCeilings: {"a.css": 2, "b.css": 1}};
		const verdict = judge({
			files: [file({path: "a.css", rawPx: px}), file({path: "b.css", rawPx: px})],
			config,
		});
		expect(verdict).toMatchObject({pass: false, rawPx: [{path: "b.css", count: 2, ceiling: 1}]});
	});

	// No ceiling entry means the file must be clean — the ratchet's whole point is that new debt
	// has to be declared to land.
	it("treats a missing ceiling entry as a ceiling of zero", () => {
		expect(
			judge({
				files: [file({path: "new.css", rawPx: [{value: "8px", line: 1}]})],
				config: emptyConfig,
			}),
		).toMatchObject({pass: false, rawPx: [{path: "new.css", count: 1, ceiling: null}]});
	});

	it("fails closed on zero CSS files", () => {
		expect(judge({files: [], config: emptyConfig})).toEqual({pass: false, reason: "zero-scope"});
	});
});

describe("the CSS parsers", () => {
	it("blanks comment bodies while keeping the line count", () => {
		expect(stripCssComments("a\n/* x\ny */\nb").split("\n")).toHaveLength(4);
	});

	it("reads declarations but not references", () => {
		expect(parseDeclaredProperties(":root { --a: 1; color: var(--b); }")).toEqual(["--a"]);
	});

	it("reads references with their line numbers", () => {
		expect(parseVarReferences("a {\n  color: var(--b);\n}")).toEqual([{name: "--b", line: 2}]);
	});

	it("ignores a declaration or reference inside a comment", () => {
		expect(parseDeclaredProperties("/* --a: 1; */")).toEqual([]);
		expect(parseVarReferences("/* var(--b) */")).toEqual([]);
	});

	it.each(["#fff", "#ffff", "#ffffff", "#ffffffff"])("reads the hex literal %s", (hex) => {
		expect(parseHexLiterals(`a { color: ${hex}; }`)).toEqual([{value: hex, line: 1}]);
	});

	// 1px and 2px are the grid's sanctioned hairline/nudge values (ADR 0162 value #1).
	it("returns only px values over 2px", () => {
		expect(parseRawPxOverTwo("a { a: 1px; b: 2px; c: 3px; }")).toEqual([{value: "3px", line: 1}]);
	});

	it("skips an at-rule line, where a px is a breakpoint", () => {
		expect(parseRawPxOverTwo("@media (min-width: 900px) {\n  a { b: 4px; }\n}")).toEqual([
			{value: "4px", line: 2},
		]);
	});
});

describe("renderReport", () => {
	it("names all three classes at once", () => {
		const report = renderReport(
			judge({
				files: [
					file({
						path: "a.css",
						varRefs: [{name: "--gone", line: 1}],
						hexLiterals: [{value: "#fff", line: 2}],
						rawPx: [{value: "8px", line: 3}],
					}),
				],
				config: emptyConfig,
			}),
		);
		expect(report).toContain("UNDEFINED TOKEN REF");
		expect(report).toContain("RAW HEX OUTSIDE tokens.css");
		expect(report).toContain("RAW-PX REGRESSION");
	});
});
