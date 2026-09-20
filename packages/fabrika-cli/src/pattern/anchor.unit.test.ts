import {describe, expect, it} from "vitest";
import {anchorOutcome, declarationLinesIn, parseCatalog, resolveDeclarations} from "./anchor.ts";

const CATALOG = {"acme-queue": "4.2.0", "@nkzw/fate": "1.3.1"};

const declared = (...lines: ReadonlyArray<string>) => resolveDeclarations(lines, CATALOG);

describe("declarationLinesIn", () => {
	// The load-bearing half: a line that OPENS the prefix and does not match in full is still a
	// declaration. Treating it as absent would answer `unanchored` for a doc that visibly claims an
	// anchor — a fail-open false negative.
	it("takes every line claiming an anchor, parsed or not", () => {
		expect(
			declarationLinesIn(`# Doc

> Derived from \`acme-queue@4.1.0\` — re-verify on pin bump.

> Derived from the in-repo source plus \`acme-queue@4.1.0\` where the lib is implicated.

Not a declaration: > Derived from something.
`),
		).toEqual([
			"> Derived from `acme-queue@4.1.0` — re-verify on pin bump.",
			"> Derived from the in-repo source plus `acme-queue@4.1.0` where the lib is implicated.",
		]);
	});
});

describe("parseCatalog", () => {
	it("reads the top-level catalog map, unquoting scoped keys", () => {
		expect(
			parseCatalog(`packages:
  - packages/*

catalog:
  # a comment
  'acme-queue': 4.2.0
  "@nkzw/fate": 1.3.1

onlyBuiltDependencies:
  - x
`),
		).toEqual({_tag: "Ok", catalog: {"acme-queue": "4.2.0", "@nkzw/fate": "1.3.1"}});
	});

	// The degrade path, not a failure: a repo that pins nothing centrally is a fact about that repo.
	it("answers a null catalog for a manifest that parses and carries none", () => {
		expect(parseCatalog("packages:\n  - packages/*\n")).toEqual({_tag: "Ok", catalog: null});
	});

	// An unreadable manifest is UNKNOWN and never `unpinned` — a 404 is a verdict, a 5xx is a verdict
	// about nothing.
	it("refuses a manifest indented with a tab, which YAML forbids", () => {
		expect(parseCatalog("catalog:\n\tacme-queue: 4.2.0\n")._tag).toBe("Unparseable");
	});

	it("refuses a catalog entry that is not a key/value pair", () => {
		expect(parseCatalog("catalog:\n  - acme-queue\n")._tag).toBe("Unparseable");
	});

	it("reads valid flow maps", () => {
		expect(parseCatalog("catalog: {acme-queue: 4.2.0}\n")).toEqual({
			_tag: "Ok",
			catalog: {"acme-queue": "4.2.0"},
		});
	});
	it.each([
		"catalog:\n  acme-queue:\n    version: 4.2.0\n",
		"catalogs: []\n",
		"catalogs:\n  legacy: null\n",
		"catalog: {acme-queue: 42}\n",
		"catalog: {acme-queue: ''}\n",
		"catalog: {acme-queue: 4.2.0, acme-queue: 4.1.0}\n",
		"catalog: {acme-queue: 4.2.0}\ncatalog: {}\n",
		"catalog: {}\nbroken: [\n",
		"[]\n",
	])("refuses invalid manifest or catalog shape %s", (text) => {
		expect(parseCatalog(text)._tag).toBe("Unparseable");
	});
	it("reads named-only maps and equal duplicate pins", () => {
		expect(
			parseCatalog("catalogs:\n  current: {acme-queue: 4.2.0}\n  other: {acme-queue: 4.2.0}\n"),
		).toEqual({_tag: "Ok", catalog: {"acme-queue": "4.2.0"}});
	});
	it("reads default and unrelated named catalog pins", () => {
		expect(
			parseCatalog("catalog: {alchemy: 2.0.0-beta.59}\ncatalogs:\n  local: {fzf: 0.5.2}\n"),
		).toEqual({_tag: "Ok", catalog: {alchemy: "2.0.0-beta.59", fzf: "0.5.2"}});
	});
	it("refuses only a declared dependency's conflicting pins", () => {
		const text =
			"catalog: {effect: 4.0.0-beta.92, alchemy: 2.0.0-beta.59}\ncatalogs:\n  local: {effect: 4.0.0-rc.112, fzf: 0.5.2}\n";
		expect(
			parseCatalog(text, ["> Derived from `effect@4.0.0-beta.92` — re-verify on pin bump."]),
		).toMatchObject({
			_tag: "Unparseable",
			reason: expect.stringContaining(
				"effect has conflicting catalog pins: 4.0.0-beta.92, 4.0.0-rc.112",
			),
		});
		expect(
			parseCatalog(text, ["> Derived from `alchemy@2.0.0-beta.59` — re-verify on pin bump."]),
		).toEqual({_tag: "Ok", catalog: {alchemy: "2.0.0-beta.59", fzf: "0.5.2"}});
	});
});

describe("resolveDeclarations", () => {
	it("compares byte for byte, with no semver interpretation", () => {
		expect(declared("> Derived from `acme-queue@^4.2.0` — re-verify on pin bump.")).toEqual([
			{package: "acme-queue", declaredVersion: "^4.2.0", pinnedVersion: "4.2.0", state: "moved"},
		]);
	});

	it("matches an exact pin and reports an absent key as unpinned", () => {
		expect(
			declared(
				"> Derived from `acme-queue@4.2.0` — re-verify on pin bump.",
				"> Derived from `@acme/retry@2.0.0` — re-verify on pin bump.",
			),
		).toEqual([
			{package: "acme-queue", declaredVersion: "4.2.0", pinnedVersion: "4.2.0", state: "matched"},
			{package: "@acme/retry", declaredVersion: "2.0.0", pinnedVersion: null, state: "unpinned"},
		]);
	});

	it("echoes a malformed line's text, clamped, with both version fields empty", () => {
		const [only] = declared("> Derived from the in-repo source plus `acme-queue@4.1.0` where …");
		expect(only).toMatchObject({state: "malformed", declaredVersion: null, pinnedVersion: null});
		expect(only?.package).toBe("the in-repo source plus `acme-queue@4.1.0` where …");
	});

	it("reports every declaration unpinned against a repo that pins nothing centrally", () => {
		expect(
			resolveDeclarations(["> Derived from `acme-queue@4.2.0` — re-verify on pin bump."], null),
		).toMatchObject([{state: "unpinned", pinnedVersion: null}]);
	});
});

describe("anchorOutcome", () => {
	const decl = (state: "matched" | "moved" | "unpinned" | "malformed") => ({
		package: "p",
		declaredVersion: "1",
		pinnedVersion: null,
		state,
	});

	it("follows the contract's precedence: moved, malformed, unpinned, matched", () => {
		expect(anchorOutcome([decl("matched"), decl("moved"), decl("malformed")])).toBe("moved");
		expect(anchorOutcome([decl("matched"), decl("malformed"), decl("unpinned")])).toBe("malformed");
		expect(anchorOutcome([decl("matched"), decl("unpinned")])).toBe("unpinned");
		expect(anchorOutcome([decl("matched")])).toBe("matched");
	});

	// `malformed` never folds into `unpinned`: one says the repo dropped the dependency, the other
	// says the line is mistyped, and the remedies are opposite.
	it("keeps malformed above unpinned rather than folding them", () => {
		expect(anchorOutcome([decl("unpinned"), decl("malformed")])).toBe("malformed");
	});

	// `unanchored` fires only when the doc carries NO claiming line — not merely when none parsed.
	it("is `unanchored` only for a doc that declares nothing at all", () => {
		expect(anchorOutcome([])).toBe("unanchored");
		expect(anchorOutcome([decl("malformed")])).not.toBe("unanchored");
	});
});
