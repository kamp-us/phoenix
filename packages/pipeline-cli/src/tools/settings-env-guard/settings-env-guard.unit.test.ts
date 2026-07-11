/**
 * Pure-core tests for `settings-env-guard` (#2495): reds on any env value carrying
 * an unexpanded brace-expansion token, passes a clean/empty block (not a vacuous
 * green), and reports the offenders. No IO — the filesystem seam is crossed in
 * `gate.unit.test.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {type EnvEntry, findLiteralExpansions, judge, renderReport} from "./settings-env-guard.ts";

// Build a literal `${VAR}` token without writing it as a plain-string placeholder,
// so biome's noTemplateCurlyInString stays quiet — this guard's whole subject IS the
// ${...} token, so spelled-out fixtures would trip the rule on nearly every line.
const brace = (name: string): string => `$\{${name}}`;
const DATA_VALUE = `${brace("CLAUDE_PROJECT_DIR")}/.claude/.pipeline-cli-data`;
const PATH_VALUE = `${brace("CLAUDE_PROJECT_DIR")}/packages/gh-phoenix/shim:/usr/bin:${brace("PATH")}`;

const entry = (key: string, value: string): EnvEntry => ({key, value});

describe("judge — red on any unexpanded brace token in an env value", () => {
	it("PASSES when no env value carries a brace token", () => {
		const verdict = judge([entry("CLAUDE_CODE_ENABLE_TELEMETRY", "1"), entry("OTEL", "otlp")]);
		expect(verdict.pass).toBe(true);
		expect(verdict.pass && verdict.scanned).toBe(2);
	});

	it("PASSES an empty env block (real pass, not a vacuous green — the whole block was scanned)", () => {
		const verdict = judge([]);
		expect(verdict.pass).toBe(true);
		expect(verdict.pass && verdict.scanned).toBe(0);
	});

	it("FAILS on the #2495 KAMPUS_PIPELINE_DATA value", () => {
		const verdict = judge([entry("KAMPUS_PIPELINE_DATA", DATA_VALUE)]);
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason).toBe("literal-expansion");
		if (verdict.pass === false) {
			expect(verdict.offenders.map((o) => o.key)).toEqual(["KAMPUS_PIPELINE_DATA"]);
		}
	});

	it("FAILS on the #2495 PATH value (both the shim prefix and the trailing brace token)", () => {
		const verdict = judge([entry("PATH", PATH_VALUE)]);
		expect(verdict.pass).toBe(false);
		if (verdict.pass === false) {
			expect(verdict.offenders.map((o) => o.key)).toEqual(["PATH"]);
		}
	});

	it("lists ONLY the offending entries, leaving clean ones out", () => {
		const verdict = judge([
			entry("CLEAN", "literal-value"),
			entry("BAD_A", `${brace("CLAUDE_PROJECT_DIR")}/x`),
			entry("CLEAN2", "/opt/homebrew/bin"),
			entry("BAD_B", `prefix:${brace("PATH")}`),
		]);
		expect(verdict.pass).toBe(false);
		if (verdict.pass === false) {
			expect(verdict.offenders.map((o) => o.key)).toEqual(["BAD_A", "BAD_B"]);
		}
	});
});

describe("findLiteralExpansions", () => {
	it("matches a brace token anywhere in the value, not just at the start", () => {
		expect(findLiteralExpansions([entry("K", `a:${brace("B")}:c`)]).map((e) => e.key)).toEqual([
			"K",
		]);
	});

	it("does NOT match a bare $VAR (unbraced) — only the braced form is the verbatim-expansion trap", () => {
		// A hook `command` uses unbraced $CLAUDE_PROJECT_DIR and shell-expands; this
		// guard is about env VALUES, where the observed non-expanding form is braced.
		expect(findLiteralExpansions([entry("K", "$HOME/x")])).toEqual([]);
	});

	it("does NOT match a literal path with no expansion token", () => {
		expect(findLiteralExpansions([entry("K", "/usr/bin:/bin")])).toEqual([]);
	});
});

describe("renderReport", () => {
	it("names each offender key=value and states the verbatim-env root cause", () => {
		const report = renderReport(judge([entry("KAMPUS_PIPELINE_DATA", DATA_VALUE)]));
		expect(report).toContain(`KAMPUS_PIPELINE_DATA = ${DATA_VALUE}`);
		expect(report).toContain("VERBATIM");
		expect(report).toContain("#2495");
	});

	it("reports the scanned count on a pass", () => {
		expect(renderReport(judge([entry("A", "1")]))).toContain("all 1");
	});
});
