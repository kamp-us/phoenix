/**
 * The pure `design-token-guard` core — parsers + `judge` (issue #2170). Deterministic
 * transforms over CSS text / gathered facts, tested with no IO. The filesystem seam
 * (`checkDesignTokens` over a fake tree) is covered in `gate.unit.test.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	type CssFileFacts,
	type DesignTokenConfig,
	judge,
	parseDeclaredProperties,
	parseHexLiterals,
	parseRawPxOverTwo,
	parseVarReferences,
	renderReport,
} from "./design-token-guard.ts";

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

describe("parseDeclaredProperties", () => {
	it("captures `--x:` declarations but NOT `var(--x)` references", () => {
		const src = `:root { --surface: var(--gray-2); --text: color-mix(in oklab, var(--a), var(--b)); }`;
		expect([...parseDeclaredProperties(src)].sort()).toEqual(["--surface", "--text"]);
	});
	it("captures declarations across density/media blocks", () => {
		const src = `:root{--s-1:4px}[data-density="normal"]{--s-1:5px}`;
		expect([...parseDeclaredProperties(src)]).toEqual(["--s-1", "--s-1"]);
	});
	it("ignores declarations inside comments", () => {
		expect([...parseDeclaredProperties(`/* --ghost: 1px; */ .a{--real:1px}`)]).toEqual(["--real"]);
	});
});

describe("parseVarReferences", () => {
	it("captures each var(--…) ref with its line, ignoring comments", () => {
		const src = `.a{\n  color: var(--accent);\n  /* var(--ghost) */\n  border-color: var( --border );\n}`;
		const refs = parseVarReferences(src);
		expect(refs.map((r) => r.name)).toEqual(["--accent", "--border"]);
		expect(refs[0]?.line).toBe(2);
		expect(refs[1]?.line).toBe(4);
	});
});

describe("parseHexLiterals", () => {
	it("matches real hex colors but not issue-ref comments like /* #2169 */", () => {
		const src = `/* fixes #2169 and #1250 */\n.a{ color: #60a5fa; background: #fff; }`;
		expect(parseHexLiterals(src).map((h) => h.value)).toEqual(["#60a5fa", "#fff"]);
	});
});

describe("parseRawPxOverTwo", () => {
	it("flags px > 2 but not the sanctioned 1px/2px grid exceptions", () => {
		const src = `.a{ border: 1px solid; outline-offset: 2px; padding: 12px; gap: 4px; }`;
		expect(parseRawPxOverTwo(src).map((p) => p.value)).toEqual(["12px", "4px"]);
	});
	it("skips the @media breakpoint value but still flags inner declarations", () => {
		const src = `@media (min-width: 768px) {\n  .a{ padding: 12px; }\n}`;
		expect(parseRawPxOverTwo(src).map((p) => p.value)).toEqual(["12px"]);
	});
	it("does not treat a hex tail or identifier as px", () => {
		expect(parseRawPxOverTwo(`.a{ color: #abc123px_not; }`)).toEqual([]);
	});
});

describe("judge — undefined-ref check", () => {
	it("PASSES a ref to a corpus-declared property (even in another file)", () => {
		const verdict = judge({
			files: [
				file({path: "tokens.css", isRawLayer: true, declared: ["--accent"]}),
				file({path: "a.css", varRefs: [{name: "--accent", line: 1}]}),
			],
			config: emptyConfig,
		});
		expect(verdict.pass).toBe(true);
	});
	it("FAILS a ref to a token declared nowhere (the Toast dead-ref class)", () => {
		const verdict = judge({
			files: [file({path: "a.css", varRefs: [{name: "--surface-1", line: 3}]})],
			config: emptyConfig,
		});
		expect(verdict.pass).toBe(false);
		if (!verdict.pass && verdict.reason === "violations") {
			expect(verdict.undefinedRefs).toEqual([{path: "a.css", name: "--surface-1", line: 3}]);
		}
	});
	it("ALLOWS a runtime-injected (externalProperties) ref", () => {
		const verdict = judge({
			files: [file({path: "a.css", varRefs: [{name: "--collapsible-panel-height", line: 1}]})],
			config: {...emptyConfig, externalProperties: ["--collapsible-panel-height"]},
		});
		expect(verdict.pass).toBe(true);
	});
	it("ALLOWS a grandfathered dead ref but still FAILS a NEW distinct one", () => {
		const verdict = judge({
			files: [
				file({
					path: "a.css",
					varRefs: [
						{name: "--t-h1", line: 1},
						{name: "--t-h9", line: 2},
					],
				}),
			],
			config: {...emptyConfig, grandfatheredMissingTokens: ["--t-h1"]},
		});
		expect(verdict.pass).toBe(false);
		if (!verdict.pass && verdict.reason === "violations") {
			expect(verdict.undefinedRefs.map((r) => r.name)).toEqual(["--t-h9"]);
		}
	});
});

describe("judge — raw-hex check", () => {
	it("FAILS a hex in a component file but ALLOWS it in the raw layer", () => {
		const verdict = judge({
			files: [
				file({path: "tokens.css", isRawLayer: true, hexLiterals: [{value: "#121113", line: 1}]}),
				file({path: "a.css", hexLiterals: [{value: "#60a5fa", line: 5}]}),
			],
			config: emptyConfig,
		});
		expect(verdict.pass).toBe(false);
		if (!verdict.pass && verdict.reason === "violations") {
			expect(verdict.hex).toEqual([{path: "a.css", value: "#60a5fa", line: 5}]);
		}
	});
});

describe("judge — raw-px ratchet", () => {
	const px = (n: number) => Array.from({length: n}, (_, i) => ({value: "12px", line: i + 1}));
	it("PASSES a file at or under its ceiling", () => {
		const verdict = judge({
			files: [file({path: "a.css", rawPx: px(3)})],
			config: {...emptyConfig, rawPxCeilings: {"a.css": 3}},
		});
		expect(verdict.pass).toBe(true);
	});
	it("FAILS a file OVER its ceiling (a regression)", () => {
		const verdict = judge({
			files: [file({path: "a.css", rawPx: px(4)})],
			config: {...emptyConfig, rawPxCeilings: {"a.css": 3}},
		});
		expect(verdict.pass).toBe(false);
		if (!verdict.pass && verdict.reason === "violations") {
			expect(verdict.rawPx[0]).toMatchObject({path: "a.css", count: 4, ceiling: 3});
		}
	});
	it("FAILS a non-baselined file with any raw-px (new file must be clean)", () => {
		const verdict = judge({
			files: [file({path: "new.css", rawPx: px(1)})],
			config: emptyConfig,
		});
		expect(verdict.pass).toBe(false);
		if (!verdict.pass && verdict.reason === "violations") {
			expect(verdict.rawPx[0]).toMatchObject({path: "new.css", count: 1, ceiling: null});
		}
	});
	it("PASSES an improvement (under ceiling) without nagging", () => {
		const verdict = judge({
			files: [file({path: "a.css", rawPx: px(1)})],
			config: {...emptyConfig, rawPxCeilings: {"a.css": 3}},
		});
		expect(verdict.pass).toBe(true);
	});
});

describe("judge — scope + reporting", () => {
	it("FAILS closed on zero CSS files (ADR 0092)", () => {
		const verdict = judge({files: [], config: emptyConfig});
		expect(verdict).toEqual({pass: false, reason: "zero-scope"});
		expect(renderReport(verdict)).toContain("fail-closed");
	});
	it("renders every violation class in one report", () => {
		const verdict = judge({
			files: [
				file({
					path: "a.css",
					varRefs: [{name: "--nope", line: 1}],
					hexLiterals: [{value: "#fff", line: 2}],
					rawPx: [{value: "9px", line: 3}],
				}),
			],
			config: emptyConfig,
		});
		const report = renderReport(verdict);
		expect(report).toContain("UNDEFINED TOKEN REF");
		expect(report).toContain("RAW HEX");
		expect(report).toContain("RAW-PX REGRESSION");
	});
});
