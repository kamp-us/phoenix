/**
 * The pure rule behind `guard patch-guard check`, ported from the v1 CLI's
 * `patch-guard.unit.test.ts` (#3051): the workspace slice, the marker grammar, and the two-way
 * cross-check. No disk — the IO seam is covered in `patch-verb.unit.test.ts`.
 *
 * The marker tag is assembled at runtime (`TAG`) rather than written contiguously, so this file —
 * itself a `*.test.ts` the real-tree scan reads — never contributes a stray pin marker of its own.
 */
import {describe, expect, it} from "vitest";
import {
	auditPins,
	cleanSummary,
	parsePatchedDependencies,
	parsePatchKey,
	parsePinMarkers,
	pinViolationReport,
} from "./patch.ts";

const TAG = ["@patch", "pin:"].join("-");

const VERB = "guard patch-guard check";

const THREE = `patchedDependencies:
  '@nkzw/fate@1.3.1': patches/@nkzw__fate@1.3.1.patch
  alchemy@2.0.0-beta.59: patches/alchemy@2.0.0-beta.59.patch
  react-fate@1.3.1: patches/react-fate@1.3.1.patch
`;

describe("parsePatchKey", () => {
	it("keeps a scoped name's leading @ and splits on the last one", () => {
		expect(parsePatchKey("@nkzw/fate@1.3.1")).toEqual({name: "@nkzw/fate", version: "1.3.1"});
	});

	it("answers null for a bare name with no version", () => {
		expect(parsePatchKey("alchemy")).toBeNull();
		expect(parsePatchKey("@scope/only")).toBeNull();
	});
});

describe("parsePatchedDependencies", () => {
	it("reads quoted + bare keys and splits scoped name@version", () => {
		expect(parsePatchedDependencies(THREE)).toEqual([
			{key: "@nkzw/fate@1.3.1", name: "@nkzw/fate", version: "1.3.1"},
			{key: "alchemy@2.0.0-beta.59", name: "alchemy", version: "2.0.0-beta.59"},
			{key: "react-fate@1.3.1", name: "react-fate", version: "1.3.1"},
		]);
	});

	it("stops at the next top-level key and tolerates blank lines", () => {
		const yaml = `catalog:\n  react: 19.0.0\npatchedDependencies:\n\n  alchemy@2.0.0-beta.59: patches/x.patch\n\npackages:\n  - packages/*\n`;
		expect(parsePatchedDependencies(yaml)).toEqual([
			{key: "alchemy@2.0.0-beta.59", name: "alchemy", version: "2.0.0-beta.59"},
		]);
	});

	it("returns empty when there is no patchedDependencies block", () => {
		expect(parsePatchedDependencies("packages:\n  - packages/*\n")).toEqual([]);
	});
});

describe("parsePinMarkers", () => {
	it("extracts markers and normalizes the scoped name@version key", () => {
		const src = `// ${TAG} @nkzw/fate@1.3.1\nimport x from "y";\n/* ${TAG} alchemy@2.0.0-beta.59 */`;
		expect(parsePinMarkers(src, "a.test.ts")).toEqual([
			{key: "@nkzw/fate@1.3.1", name: "@nkzw/fate", version: "1.3.1", path: "a.test.ts"},
			{key: "alchemy@2.0.0-beta.59", name: "alchemy", version: "2.0.0-beta.59", path: "a.test.ts"},
		]);
	});

	it("records a malformed (versionless) marker so it surfaces as stale, never dropped", () => {
		expect(parsePinMarkers(`// ${TAG} react-fate`, "b.test.ts")).toEqual([
			{key: "react-fate", name: "react-fate", version: "", path: "b.test.ts"},
		]);
	});
});

describe("auditPins", () => {
	const patched = parsePatchedDependencies(THREE);

	it("finds nothing when every patched dep has a matching pin (the on-main state)", () => {
		const markers = [
			...parsePinMarkers(`// ${TAG} @nkzw/fate@1.3.1`, "src/fate/nkzw.test.ts"),
			...parsePinMarkers(`// ${TAG} alchemy@2.0.0-beta.59`, "apps/web/tests/flagship.test.ts"),
			...parsePinMarkers(`// ${TAG} react-fate@1.3.1`, "src/fate/useView.test.tsx"),
		];
		expect(auditPins(patched, markers)).toEqual({missing: [], stale: []});
	});

	it("names the unpinned dep when a patched dep has no marker", () => {
		const markers = [
			...parsePinMarkers(`// ${TAG} @nkzw/fate@1.3.1`, "a.test.ts"),
			...parsePinMarkers(`// ${TAG} alchemy@2.0.0-beta.59`, "b.test.ts"),
		];
		const audit = auditPins(patched, markers);
		expect(audit.missing.map((d) => d.key)).toEqual(["react-fate@1.3.1"]);
		expect(audit.stale).toEqual([]);
	});

	it("names the stale marker when a pin's version is no longer maintained", () => {
		const markers = [
			...parsePinMarkers(`// ${TAG} @nkzw/fate@1.3.1`, "a.test.ts"),
			...parsePinMarkers(`// ${TAG} alchemy@2.0.0-beta.59`, "b.test.ts"),
			...parsePinMarkers(`// ${TAG} react-fate@1.3.1`, "c.test.tsx"),
			...parsePinMarkers(`// ${TAG} alchemy@2.0.0-beta.1`, "stale.test.ts"),
		];
		const audit = auditPins(patched, markers);
		expect(audit.missing).toEqual([]);
		expect(audit.stale.map((m) => m.key)).toEqual(["alchemy@2.0.0-beta.1"]);
	});
});

describe("the reports", () => {
	it("names every scanned patch in the clean summary", () => {
		const summary = cleanSummary(VERB, ["alchemy@2.0.0-beta.59"], 1);
		expect(summary).toContain("all 1 maintained patch carry");
		expect(summary).toContain("alchemy@2.0.0-beta.59");
	});

	it("names both the unpinned patch and the stale pin's file", () => {
		const patched = parsePatchedDependencies(THREE);
		const markers = parsePinMarkers(`// ${TAG} alchemy@2.0.0-beta.1`, "stale.test.ts");
		const report = pinViolationReport(
			VERB,
			patched.map((p) => p.key),
			auditPins(patched, markers),
		);
		expect(report).toContain("3 unpinned patches and 1 stale pin");
		expect(report).toContain("react-fate@1.3.1");
		expect(report).toContain("stale.test.ts");
	});
});
