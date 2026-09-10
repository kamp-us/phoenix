import {describe, expect, it} from "vitest";
import {
	classify,
	isAgentWorktree,
	type Liveness,
	QUIET_WINDOW_SECONDS,
	type TreeFacts,
	unprovenAmong,
} from "./reap.ts";

const TRUNK = "origin/main";
const PATH = "/repo/.claude/worktrees/agent-a9bd";
const NOBODY: ReadonlySet<string> = new Set();

const facts = (over: Partial<TreeFacts> = {}): TreeFacts => ({
	path: PATH,
	branch: null,
	locked: null,
	prunable: false,
	uncommitted: {_tag: "Read", paths: 0},
	landing: {_tag: "Ancestor"},
	liveness: {_tag: "Quiet"},
	...over,
});

/** The incident shape: a seat's tree, touched minutes ago, clean and level with the trunk. */
const LIVE: Liveness = {
	_tag: "Live",
	signals: [{_tag: "RecentActivity", ageSeconds: 41 * 60, windowSeconds: QUIET_WINDOW_SECONDS}],
};

describe("isAgentWorktree", () => {
	it("admits a harness-provisioned agent tree", () => {
		expect(isAgentWorktree("/repo/.claude/worktrees/agent-a9bd")).toBe(true);
	});

	it("refuses the primary checkout and a sibling scratch checkout", () => {
		expect(isAgentWorktree("/repo")).toBe(false);
		expect(isAgentWorktree("/private/tmp/repo-7166-build")).toBe(false);
	});

	it("refuses a worktrees sibling that is not an agent tree", () => {
		expect(isAgentWorktree("/repo/.claude/worktrees/manual-spike")).toBe(false);
	});

	it("refuses a bare `agent-` with no name after it", () => {
		expect(isAgentWorktree("/repo/.claude/worktrees/agent-")).toBe(false);
	});

	it("matches the directory, never a path that merely mentions it", () => {
		expect(isAgentWorktree("/repo/docs/.claude-worktrees-agent-notes.md")).toBe(false);
	});
});

describe("classify — the positive proofs the trunk gives", () => {
	it("removes a clean, unlocked tree whose HEAD is reachable from the trunk", () => {
		expect(classify(facts(), TRUNK, NOBODY)).toMatchObject({_tag: "Remove", license: "ancestor"});
	});

	it("removes a tree whose work landed as a squash, naming the trunk commit that carries it", () => {
		const verdict = classify(
			facts({landing: {_tag: "Squashed", commit: "99ef1f6"}, branch: "build/4082-x-43cc4b51"}),
			TRUNK,
			NOBODY,
		);
		expect(verdict).toMatchObject({_tag: "Remove", license: "squashed"});
		expect(verdict._tag === "Remove" && verdict.because).toMatch(/99ef1f6/);
	});

	it("removes a tree whose HEAD adds nothing the trunk does not already carry", () => {
		expect(classify(facts({landing: {_tag: "NoChange"}}), TRUNK, NOBODY)).toMatchObject({
			_tag: "Remove",
			license: "no-change",
		});
	});
});

describe("classify — everything short of a proof is KEEP", () => {
	it("keeps the tree this run is standing in, however landed and clean", () => {
		const verdict = classify(facts(), TRUNK, new Set([PATH]));
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/standing in/);
	});

	it("keeps a locked tree and quotes git's own lock reason", () => {
		const verdict = classify(facts({locked: "held by the harness"}), TRUNK, NOBODY);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/held by the harness/);
	});

	it("keeps a locked tree that carries no reason", () => {
		expect(classify(facts({locked: ""}), TRUNK, NOBODY)._tag).toBe("Keep");
	});

	it("keeps a dirty tree — a bulk sweep's strongest git-level use signal", () => {
		const verdict = classify(facts({uncommitted: {_tag: "Read", paths: 3}}), TRUNK, NOBODY);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/3 uncommitted/);
	});

	it("keeps a tree carrying work the trunk does not", () => {
		expect(classify(facts({landing: {_tag: "Unlanded"}}), TRUNK, NOBODY)._tag).toBe("Keep");
	});

	it("keeps a tree whose landing could not be read — UNKNOWN is never 'landed'", () => {
		const verdict = classify(
			facts({landing: {_tag: "Unknown", reason: "no merge base"}}),
			TRUNK,
			NOBODY,
		);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/UNKNOWN: no merge base/);
	});

	it("keeps a tree whose dirtiness could not be read — UNKNOWN is never 'clean'", () => {
		const verdict = classify(
			facts({uncommitted: {_tag: "Unknown", reason: "not a git repository"}}),
			TRUNK,
			NOBODY,
		);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/UNKNOWN: not a git repository/);
	});

	it("keeps a registration git already calls prunable — there is no tree to remove", () => {
		const verdict = classify(facts({prunable: true}), TRUNK, NOBODY);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/worktree prune/);
	});
});

describe("classify — a live seat survives the git proofs", () => {
	it("keeps a clean, unlocked, ancestor-HEAD tree that reads live — the incident shape", () => {
		const verdict = classify(facts({liveness: LIVE}), TRUNK, NOBODY);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/reads live/);
	});

	it("names which signal held, so a dry-run plan says why the seat survived", () => {
		const verdict = classify(facts({liveness: LIVE}), TRUNK, NOBODY);
		expect(verdict.because).toMatch(
			/directory was last written 41m ago, inside the 1d quiet window/,
		);
	});

	it("removes that same tree once it has gone quiet", () => {
		expect(classify(facts(), TRUNK, NOBODY)).toMatchObject({_tag: "Remove", license: "ancestor"});
	});

	it("keeps a tree whose liveness could not be read — UNKNOWN never licenses a removal", () => {
		const verdict = classify(
			facts({liveness: {_tag: "Unknown", reason: "its directory could not be read"}}),
			TRUNK,
			NOBODY,
		);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/UNKNOWN: its directory could not be read/);
	});

	it("keeps a live tree whose work is unlanded too — the arms do not cancel", () => {
		expect(classify(facts({liveness: LIVE, landing: {_tag: "Unlanded"}}), TRUNK, NOBODY)._tag).toBe(
			"Keep",
		);
	});
});

describe("unprovenAmong", () => {
	it("names a removal whose registration survived the read-back", () => {
		expect(unprovenAmong(["/a", "/b"], ["/b", "/repo"])).toEqual(["/b"]);
	});

	it("names none when every attempted removal is gone", () => {
		expect(unprovenAmong(["/a", "/b"], ["/repo"])).toEqual([]);
	});
});
