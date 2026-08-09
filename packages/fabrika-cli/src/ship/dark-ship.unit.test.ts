import {describe, expect, it} from "vitest";
import {
	addsDeclaration,
	declaredKeyOf,
	declaredKeysIn,
	detect,
	FLAG_REGISTRY,
	referencedKeyOf,
} from "./dark-ship.ts";

const REGISTRY = `export const flags = [
	FlagshipFlag("sozluk-vote-widget", {defaultVariation: "off"}),
	FlagshipFlag("pano-inline-reply", {defaultVariation: "off"}),
];
`;

const ADDING_DIFF = `diff --git a/${FLAG_REGISTRY} b/${FLAG_REGISTRY}
--- a/${FLAG_REGISTRY}
+++ b/${FLAG_REGISTRY}
@@ -1,2 +1,3 @@
 export const flags = [
+	FlagshipFlag("sozluk-new-thing", {defaultVariation: "off"}),
`;

const UNRELATED_DIFF = `diff --git a/apps/web/src/App.tsx b/apps/web/src/App.tsx
--- a/apps/web/src/App.tsx
+++ b/apps/web/src/App.tsx
@@ -1,1 +1,2 @@
+const a = 1;
`;

describe("addsDeclaration", () => {
	it("fires on an added FlagshipFlag row inside the registry module", () => {
		expect(addsDeclaration(ADDING_DIFF)).toBe(true);
	});

	it("does not fire on a diff that touches no registry file", () => {
		expect(addsDeclaration(UNRELATED_DIFF)).toBe(false);
	});

	it("does not fire on a REMOVED declaration — retirement is not a dark ship", () => {
		const removing = ADDING_DIFF.replace(
			'+	FlagshipFlag("sozluk-new-thing", {defaultVariation: "off"}),',
			'-	FlagshipFlag("sozluk-new-thing", {defaultVariation: "off"}),',
		);
		expect(addsDeclaration(removing)).toBe(false);
	});
});

describe("declaredKeyOf", () => {
	it("reads a plain `Flag:` line", () => {
		expect(declaredKeyOf("body\n\nFlag: sozluk-vote-widget\n")).toBe("sozluk-vote-widget");
	});

	it("tolerates bold and a `Flag key:` spelling", () => {
		expect(declaredKeyOf("**Flag key:** `pano-inline-reply`")).toBe("pano-inline-reply");
	});

	it("ignores a `Flag:` line quoted inside a fence — an example is not a claim", () => {
		expect(declaredKeyOf("```\nFlag: sozluk-vote-widget\n```")).toBeNull();
	});
});

describe("declaredKeysIn", () => {
	it("reads every key the registry declares", () => {
		expect([...declaredKeysIn(REGISTRY)].sort()).toEqual([
			"pano-inline-reply",
			"sozluk-vote-widget",
		]);
	});
});

describe("referencedKeyOf", () => {
	const declared = declaredKeysIn(REGISTRY);

	it("catches a reused flag named on a gating line — the #2086 miss", () => {
		expect(referencedKeyOf("The new path is gated behind sozluk-vote-widget.", declared)).toBe(
			"sozluk-vote-widget",
		);
	});

	it("does NOT mint a phantom release from a prose mention — the #2897 edge", () => {
		expect(referencedKeyOf("We retired sozluk-vote-widget last cycle.", declared)).toBeNull();
	});

	it("does not match a key that is a substring of a longer token", () => {
		expect(referencedKeyOf("gated behind sozluk-vote-widget-v2", declared)).toBeNull();
	});
});

describe("detect", () => {
	it("reports a dark ship with its key when the body declares one", () => {
		expect(detect(UNRELATED_DIFF, "Flag: sozluk-vote-widget", REGISTRY)).toEqual({
			dark: true,
			key: "sozluk-vote-widget",
		});
	});

	it("reports a dark ship with no key when only the diff signal fires", () => {
		expect(detect(ADDING_DIFF, "no flag line here", REGISTRY)).toEqual({dark: true, key: null});
	});

	it("never reads an inherited Containment stamp — that is the #1257 phantom", () => {
		expect(detect(UNRELATED_DIFF, "**Containment:** flag (default-off)", REGISTRY).dark).toBe(
			false,
		);
	});
});
