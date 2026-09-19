import {describe, expect, it} from "vitest";
import {
	changedPathsIn,
	directoryMarketplacesAt,
	dirtyPathsIn,
	installsFrom,
	plan,
	reportInstalls,
	type WorktreeFacts,
} from "./plugin-sync.ts";

const facts = (over: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
	branch: "main",
	defaultBranch: "main",
	dirtyPaths: [],
	head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	remoteHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	incomingPaths: ["skills/build/SKILL.md"],
	fastForwardable: true,
	...over,
});

describe("the plugin-source sync plan", () => {
	it("advances the default branch when every precondition holds", () => {
		expect(plan(facts())).toEqual({
			_tag: "FastForward",
			branch: "main",
			from: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			to: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		});
	});

	it("says the source is current when it is, rather than proposing a no-op merge", () => {
		const already = plan(facts({remoteHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}));
		expect(already._tag).toBe("Current");
	});

	it("reads a current source over a dirty tree — a clean read needs no clean tree", () => {
		const already = plan(
			facts({
				dirtyPaths: ["skills/build/SKILL.md"],
				remoteHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			}),
		);
		expect(already._tag).toBe("Current");
	});

	it.each([
		["a parked branch", facts({branch: "release/next"}), "is on release/next"],
		["a detached HEAD", facts({branch: null}), "detached HEAD"],
		[
			"uncommitted work the incoming commits also change",
			facts({dirtyPaths: [".fabrika.jsonc", "skills/build/SKILL.md"]}),
			"uncommitted changes the incoming commits also change (skills/build/SKILL.md)",
		],
		["a diverged branch", facts({fastForwardable: false}), "has diverged"],
	])("refuses %s, and names the reason rather than moving anything", (_label, given, quoted) => {
		const decided = plan(given);
		expect(decided._tag).toBe("Refused");
		expect(decided._tag === "Refused" && decided.reason).toContain(quoted);
	});

	/**
	 * The narrowing itself: `git merge --ff-only` takes this move and leaves the edit alone, so the
	 * refusal that used to fire here left a checkout carrying one standing local-only file behind at
	 * every session start.
	 */
	it("advances over dirt the incoming commits never touch", () => {
		expect(plan(facts({dirtyPaths: [".fabrika.jsonc"]}))._tag).toBe("FastForward");
	});

	it("refuses an untracked file an incoming commit would create — that one is a clobber", () => {
		const decided = plan(
			facts({
				dirtyPaths: ["skills/build/references/code.md"],
				incomingPaths: ["skills/build/references/code.md"],
			}),
		);
		expect(decided._tag === "Refused" && decided.reason).toContain(
			"skills/build/references/code.md",
		);
	});

	it("counts the overlap it does not quote, rather than naming three paths and stopping", () => {
		const overlapping = ["a.md", "b.md", "c.md", "d.md"];
		const decided = plan(facts({dirtyPaths: overlapping, incomingPaths: overlapping}));
		expect(decided._tag === "Refused" && decided.reason).toContain("(a.md, b.md, c.md and 1 more)");
	});

	/**
	 * The off-default arms run before the ancestry arm on purpose: on a parked branch the ancestry
	 * fact answers a question nobody asked, and a refusal that quoted it would send its reader to
	 * `origin/main` when what stopped the move was the branch the operator chose.
	 */
	it("names the branch, not the ancestry, when both would refuse", () => {
		const decided = plan(facts({branch: "release/next", fastForwardable: false}));
		expect(decided._tag === "Refused" && decided.reason).toContain("is on release/next");
	});
});

describe("reading the paths the two git lists name", () => {
	it("takes every NUL-separated entry a name-only diff holds", () => {
		expect(changedPathsIn("one.md\0two with space.md\0")).toEqual(["one.md", "two with space.md"]);
	});

	it("reads nothing out of an empty answer, so an empty range overlaps with nothing", () => {
		expect(changedPathsIn("")).toEqual([]);
		expect(dirtyPathsIn("")).toEqual([]);
	});

	it("strips the two status letters and the space, keeping the path whole", () => {
		expect(dirtyPathsIn(" M .fabrika.jsonc\0?? notes/new file.md\0")).toEqual([
			".fabrika.jsonc",
			"notes/new file.md",
		]);
	});

	/** Both ends of a rename count: the incoming commits can collide with either one. */
	it("takes a rename's origin path from the field that follows it", () => {
		expect(dirtyPathsIn("R  after.md\0before.md\0 M other.md\0")).toEqual([
			"after.md",
			"before.md",
			"other.md",
		]);
	});
});

describe("selecting the marketplace by the directory it declares", () => {
	const registry = {
		local: {source: {source: "directory", path: "/src/repo"}},
		other: {source: {source: "directory", path: "/src/elsewhere"}},
		remote: {source: {source: "github", repo: "owner/name"}},
	};

	it("matches a directory source on its declared path and nothing else", () => {
		expect(directoryMarketplacesAt(registry, "/src/repo")).toEqual(["local"]);
	});

	it("claims no forge-hosted marketplace — moving a local checkout would not serve one", () => {
		expect(directoryMarketplacesAt(registry, "owner/name")).toEqual([]);
	});

	it("yields no row from an unreadable record, so a caller can never read one as a pass", () => {
		expect(directoryMarketplacesAt(null, "/src/repo")).toEqual([]);
		expect(directoryMarketplacesAt({local: {source: 7}}, "/src/repo")).toEqual([]);
	});
});

describe("reading the installs taken from those marketplaces", () => {
	const installs = {
		plugins: {
			"tool@local": [{gitCommitSha: "aaaa"}, {gitCommitSha: "bbbb"}, {gitCommitSha: "bbbb"}],
			"tool@remote": [{gitCommitSha: "cccc"}],
			"nosha@local": [{installPath: "/somewhere"}],
		},
	};

	it("keeps one row per commit, since two scopes can sit at two different commits", () => {
		expect(installsFrom(installs, ["local"])).toEqual([
			{pluginId: "tool@local", commit: "aaaa", records: 1},
			{pluginId: "tool@local", commit: "bbbb", records: 2},
		]);
	});

	it("folds the repetition and keeps the count, rather than dropping a record silently", () => {
		const folded = installsFrom(installs, ["local"]).find((row) => row.commit === "bbbb");
		expect(folded?.records).toBe(2);
	});

	it("drops a record carrying no commit — an absent commit is not a lag to report", () => {
		expect(installsFrom(installs, ["local"]).some((row) => row.pluginId === "nosha@local")).toBe(
			false,
		);
	});

	it("reports every install bound at the source commit as bound", () => {
		const report = reportInstalls([{pluginId: "tool@local", commit: "aaaa", records: 1}], "aaaa");
		expect(report._tag).toBe("Bound");
	});

	it("reports an install copied from an earlier commit, and names only the lagging ones", () => {
		const report = reportInstalls(
			[
				{pluginId: "tool@local", commit: "aaaa", records: 1},
				{pluginId: "tool@local", commit: "bbbb", records: 3},
			],
			"aaaa",
		);
		expect(report._tag).toBe("Lagging");
		expect(report._tag === "Lagging" && report.rows).toEqual([
			{pluginId: "tool@local", commit: "bbbb", records: 3},
		]);
	});

	it("reads no rows as UNKNOWN, never as bound — an unread record proves nothing", () => {
		expect(reportInstalls([], "aaaa")._tag).toBe("Unknown");
	});
});
