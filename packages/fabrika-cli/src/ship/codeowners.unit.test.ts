import {describe, expect, it} from "vitest";
import {
	classify,
	controlPlaneOwnersOf,
	matcherFor,
	ownersOf,
	parseCodeowners,
	splitTeam,
} from "./codeowners.ts";

const TEAM = "@kamp-us/control-plane";

const ROWS = parseCodeowners(`# comment
/.github/                     ${TEAM}
**/lefthook*                  ${TEAM}
/packages/demo-cli/src/*  ${TEAM}
/packages/demo-cli/src/tools/
/packages/demo-cli/src/tools/verdict/  ${TEAM}
`);

describe("parseCodeowners", () => {
	it("keeps an owner-less row — it is the documented ownership-UNSET idiom, not a blank line", () => {
		expect(ROWS.some((row) => row.pattern.endsWith("tools/") && row.owners.length === 0)).toBe(
			true,
		);
	});

	it("drops comments and trailing comment text", () => {
		expect(ROWS.some((row) => row.pattern.startsWith("#"))).toBe(false);
	});
});

describe("matcherFor", () => {
	it("treats a trailing slash as a directory prefix", () => {
		expect(matcherFor("/.github/").test(".github/workflows/ci.yml")).toBe(true);
		expect(matcherFor("/.github/").test("github/ci.yml")).toBe(false);
	});

	it("keeps a wildcard within its segment — `src/*` owns the root and no deeper", () => {
		const pattern = matcherFor("/packages/demo-cli/src/*");
		expect(pattern.test("packages/demo-cli/src/registry.ts")).toBe(true);
		expect(pattern.test("packages/demo-cli/src/tools/thing.ts")).toBe(false);
	});

	it("escapes regex metacharacters in a pattern — a `.` matches a dot, not any character", () => {
		expect(matcherFor("/biome.jsonc").test("biome.jsonc")).toBe(true);
		expect(matcherFor("/biome.jsonc").test("biomeXjsonc")).toBe(false);
	});

	it("matches `**/` at any depth", () => {
		expect(matcherFor("**/lefthook*").test("lefthook.yml")).toBe(true);
		expect(matcherFor("**/lefthook*").test("apps/web/lefthook.yml")).toBe(true);
	});
});

describe("ownersOf", () => {
	it("resolves LAST match wins, so an owner-less row un-owns what a broader row swept in", () => {
		expect(ownersOf(ROWS, "packages/demo-cli/src/tools/thing.ts")).toEqual([]);
	});

	it("lets a later specific row re-own inside an un-owned directory", () => {
		expect(ownersOf(ROWS, "packages/demo-cli/src/tools/verdict/index.ts")).toEqual([TEAM]);
	});

	it("returns null for a path no row matches — distinct from a row that owns nobody", () => {
		expect(ownersOf(ROWS, "apps/web/src/App.tsx")).toBeNull();
	});
});

describe("controlPlaneOwnersOf", () => {
	it("reads the team off the file rather than carrying a hardcoded name", () => {
		expect(controlPlaneOwnersOf(ROWS)).toEqual([TEAM]);
	});

	it("counts an individual @login owner exactly as an @org/team owner (#6299)", () => {
		expect(controlPlaneOwnersOf(parseCodeowners("/a/ @someone\n"))).toEqual(["@someone"]);
	});

	it("takes both shapes off one file, distinct and in first-appearance order", () => {
		expect(controlPlaneOwnersOf(parseCodeowners(`/a/ @someone ${TEAM}\n/b/ @someone\n`))).toEqual([
			"@someone",
			TEAM,
		]);
	});

	it("ignores an email owner — it names no account a roster or an approval resolves against", () => {
		expect(controlPlaneOwnersOf(parseCodeowners("/a/ owner@example.test\n"))).toEqual([]);
	});
});

describe("classify", () => {
	it("is control-plane when a changed path resolves to the team", () => {
		expect(classify(ROWS, [".github/workflows/ci.yml"])).toBe("control-plane");
	});

	it("is not-control-plane when every changed path resolves elsewhere", () => {
		expect(classify(ROWS, ["apps/web/src/App.tsx"])).toBe("not-control-plane");
	});

	it("is not-control-plane for a .decisions/-only set — ADRs are not §CP (#5531)", () => {
		expect(classify(ROWS, [".decisions/0240-a.md", ".decisions/0241-b.md"])).toBe(
			"not-control-plane",
		);
	});

	it("stays control-plane when a .decisions/ file rides alongside an owned path (#5531)", () => {
		expect(classify(ROWS, [".decisions/0240-a.md", ".github/workflows/ci.yml"])).toBe(
			"control-plane",
		);
	});

	it("is not-control-plane for a .decisions/-only set an individual-owner boundary bounds", () => {
		expect(classify(parseCodeowners("/a/ @someone\n"), [".decisions/0240-a.md"])).toBe(
			"not-control-plane",
		);
	});

	it("is control-plane when a changed path resolves to an individual @login owner (#6299)", () => {
		expect(classify(parseCodeowners("/a/ @someone\n"), ["a/b.ts"])).toBe("control-plane");
	});

	it("holds on unknown for a boundary whose only owners are emails — never match-everything (#4401)", () => {
		expect(classify(parseCodeowners("/a/ owner@example.test\n"), ["a/b.ts"])).toBe("unknown");
	});

	it("holds on unknown for a match-everything individual-owner row too", () => {
		expect(classify(parseCodeowners("* @someone\n"), ["a/b.ts"])).toBe("unknown");
	});

	it("holds on unknown for a match-everything row — the #4336 adopter sentinel", () => {
		expect(classify(parseCodeowners(`* ${TEAM}\n`), ["apps/web/src/App.tsx"])).toBe("unknown");
	});

	it("holds on unknown for a boundary with zero rows — a PRESENT but empty file, not an absent one", () => {
		expect(classify([], ["apps/web/src/App.tsx"])).toBe("unknown");
	});
});

describe("splitTeam", () => {
	it("splits an @org/team owner into the two segments the REST roster read needs", () => {
		expect(splitTeam(TEAM)).toEqual({org: "kamp-us", team: "control-plane"});
	});

	it("answers null for an individual owner — the discriminator cp-approval routes the roster on", () => {
		expect(splitTeam("@someone")).toBeNull();
	});
});
