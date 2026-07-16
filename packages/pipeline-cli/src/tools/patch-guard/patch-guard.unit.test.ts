/**
 * `patch-guard` pure-core tests (#3051) — the verdict logic over already-gathered
 * facts: every patched dep with a matching pin passes, an unpinned patch fails, a
 * stale marker fails, and an empty patch set fails closed (ADR 0092). No disk — the IO
 * seam is covered in `gate.unit.test.ts`.
 *
 * The marker tag is assembled at runtime (`TAG`) rather than written contiguously so
 * this file — itself a `*.test.ts` the real-tree scan reads — never contributes a stray
 * pin marker of its own.
 */
import {describe, expect, it} from "@effect/vitest";
import {judge, parsePatchedDependencies, parsePinMarkers} from "./patch-guard.ts";

// The literal marker tag, kept non-contiguous in source (see file docblock).
const TAG = ["@patch", "pin:"].join("-");

const THREE = `patchedDependencies:
  '@nkzw/fate@1.3.1': patches/@nkzw__fate@1.3.1.patch
  alchemy@2.0.0-beta.59: patches/alchemy@2.0.0-beta.59.patch
  react-fate@1.3.1: patches/react-fate@1.3.1.patch
`;

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
		const markers = parsePinMarkers(`// ${TAG} react-fate`, "b.test.ts");
		expect(markers).toEqual([
			{key: "react-fate", name: "react-fate", version: "", path: "b.test.ts"},
		]);
	});
});

describe("judge — the patch-guard verdict", () => {
	const patched = parsePatchedDependencies(THREE);

	it("PASSES when every patched dep has a matching pin (the on-main state)", () => {
		const markers = [
			...parsePinMarkers(`// ${TAG} @nkzw/fate@1.3.1`, "src/fate/nkzw.test.ts"),
			...parsePinMarkers(`// ${TAG} alchemy@2.0.0-beta.59`, "apps/web/tests/flagship.test.ts"),
			...parsePinMarkers(`// ${TAG} react-fate@1.3.1`, "src/fate/useView.test.tsx"),
		];
		const v = judge(patched, markers);
		expect(v.pass).toBe(true);
		if (!v.pass) throw new Error("expected pass");
		expect(v.patched).toEqual(["@nkzw/fate@1.3.1", "alchemy@2.0.0-beta.59", "react-fate@1.3.1"]);
	});

	it("FAILS (missing-pin) when a patched dep has no marker, naming the unpinned dep", () => {
		const markers = [
			...parsePinMarkers(`// ${TAG} @nkzw/fate@1.3.1`, "a.test.ts"),
			...parsePinMarkers(`// ${TAG} alchemy@2.0.0-beta.59`, "b.test.ts"),
			// react-fate@1.3.1 has NO pin
		];
		const v = judge(patched, markers);
		expect(v.pass).toBe(false);
		if (v.pass || v.reason !== "pin-violations") throw new Error("expected pin-violations");
		expect(v.missing.map((d) => d.key)).toEqual(["react-fate@1.3.1"]);
		expect(v.stale).toEqual([]);
	});

	it("FAILS (stale-pin) when a marker names a dep/version not in patchedDependencies", () => {
		const markers = [
			...parsePinMarkers(`// ${TAG} @nkzw/fate@1.3.1`, "a.test.ts"),
			...parsePinMarkers(`// ${TAG} alchemy@2.0.0-beta.59`, "b.test.ts"),
			...parsePinMarkers(`// ${TAG} react-fate@1.3.1`, "c.test.tsx"),
			// stale: a version that no longer matches the maintained patch
			...parsePinMarkers(`// ${TAG} alchemy@2.0.0-beta.1`, "stale.test.ts"),
		];
		const v = judge(patched, markers);
		expect(v.pass).toBe(false);
		if (v.pass || v.reason !== "pin-violations") throw new Error("expected pin-violations");
		expect(v.missing).toEqual([]);
		expect(v.stale.map((m) => m.key)).toEqual(["alchemy@2.0.0-beta.1"]);
	});

	it("FAILS (fail-closed, zero-scope) when there are no patchedDependencies", () => {
		const v = judge([], parsePinMarkers(`// ${TAG} alchemy@2.0.0-beta.59`, "x.test.ts"));
		expect(v.pass).toBe(false);
		if (v.pass) throw new Error("expected fail");
		expect(v.reason).toBe("zero-scope");
	});
});
