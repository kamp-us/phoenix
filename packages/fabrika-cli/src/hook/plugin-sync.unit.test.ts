import {describe, expect, it} from "vitest";
import {
	directoryMarketplacesAt,
	installsFrom,
	plan,
	reportInstalls,
	type WorktreeFacts,
} from "./plugin-sync.ts";

const facts = (over: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
	branch: "main",
	defaultBranch: "main",
	dirty: false,
	head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	remoteHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
			facts({dirty: true, remoteHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}),
		);
		expect(already._tag).toBe("Current");
	});

	it.each([
		["a parked branch", facts({branch: "release/next"}), "is on release/next"],
		["a detached HEAD", facts({branch: null}), "detached HEAD"],
		["uncommitted work", facts({dirty: true}), "uncommitted changes"],
		["a diverged branch", facts({fastForwardable: false}), "has diverged"],
	])("refuses %s, and names the reason rather than moving anything", (_label, given, quoted) => {
		const decided = plan(given);
		expect(decided._tag).toBe("Refused");
		expect(decided._tag === "Refused" && decided.reason).toContain(quoted);
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
