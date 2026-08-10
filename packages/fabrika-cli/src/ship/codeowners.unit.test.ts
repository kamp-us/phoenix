import {describe, expect, it} from "vitest";
import {
	classify,
	matcherFor,
	ownersOf,
	parseCodeowners,
	splitTeam,
	teamOwnersOf,
} from "./codeowners.ts";

const TEAM = "@kamp-us/control-plane";

const ROWS = parseCodeowners(`# comment
/.github/                     ${TEAM}
**/lefthook*                  ${TEAM}
/packages/pipeline-cli/src/*  ${TEAM}
/packages/pipeline-cli/src/tools/
/packages/pipeline-cli/src/tools/verdict/  ${TEAM}
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
		const pattern = matcherFor("/packages/pipeline-cli/src/*");
		expect(pattern.test("packages/pipeline-cli/src/registry.ts")).toBe(true);
		expect(pattern.test("packages/pipeline-cli/src/tools/thing.ts")).toBe(false);
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
		expect(ownersOf(ROWS, "packages/pipeline-cli/src/tools/thing.ts")).toEqual([]);
	});

	it("lets a later specific row re-own inside an un-owned directory", () => {
		expect(ownersOf(ROWS, "packages/pipeline-cli/src/tools/verdict/index.ts")).toEqual([TEAM]);
	});

	it("returns null for a path no row matches — distinct from a row that owns nobody", () => {
		expect(ownersOf(ROWS, "apps/web/src/App.tsx")).toBeNull();
	});
});

describe("teamOwnersOf", () => {
	it("reads the team off the file rather than carrying a hardcoded name", () => {
		expect(teamOwnersOf(ROWS)).toEqual([TEAM]);
	});

	it("ignores individual owners — only an @org/team row bounds the §CP surface", () => {
		expect(teamOwnersOf(parseCodeowners("/a/ @someone\n"))).toEqual([]);
	});
});

describe("classify", () => {
	it("is control-plane when a changed path resolves to the team", () => {
		expect(classify(ROWS, [".github/workflows/ci.yml"])).toBe("control-plane");
	});

	it("is not-control-plane when every changed path resolves elsewhere", () => {
		expect(classify(ROWS, ["apps/web/src/App.tsx"])).toBe("not-control-plane");
	});

	it("holds on content-undetermined when a .decisions/ file changed with no owned match", () => {
		expect(classify(ROWS, [".decisions/0240-a.md"])).toBe("content-undetermined");
	});

	it("holds on unknown for a boundary with zero team-owned rows — never match-everything (#4401)", () => {
		expect(classify(parseCodeowners("/a/ @someone\n"), ["a/b.ts"])).toBe("unknown");
	});

	it("holds on unknown for a match-everything row — the #4336 adopter sentinel", () => {
		expect(classify(parseCodeowners(`* ${TEAM}\n`), ["apps/web/src/App.tsx"])).toBe("unknown");
	});

	it("holds on unknown for an absent CODEOWNERS, which parses to zero rows", () => {
		expect(classify([], ["apps/web/src/App.tsx"])).toBe("unknown");
	});
});

describe("splitTeam", () => {
	it("splits an @org/team owner into the two segments the REST roster read needs", () => {
		expect(splitTeam(TEAM)).toEqual({org: "kamp-us", team: "control-plane"});
	});

	it("refuses an individual owner", () => {
		expect(splitTeam("@someone")).toBeNull();
	});
});
