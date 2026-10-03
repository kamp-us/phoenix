import {describe, expect, it} from "vitest";
import {
	type BoardFacts,
	type BranchFate,
	classify,
	classifyCheap,
	classifyGit,
	fateOfPulls,
	fateOfTicket,
	isAgentWorktree,
	type Liveness,
	QUIET_WINDOW_SECONDS,
	ticketOf,
	unprovenAmong,
} from "./reap.ts";

const TRUNK = "origin/main";
const PATH = "/repo/.claude/worktrees/agent-a9bd";
const NOBODY: ReadonlySet<string> = new Set();
const BRANCH = "build/8572-editor-focus-43cc4b51";

const NO_BRANCH: BranchFate = {
	_tag: "Unproven",
	reason: "it holds no branch, so there is no issue or pull request to ask about",
};
const ENDED: BranchFate = {
	_tag: "Ended",
	branch: BRANCH,
	because: `pull request #8572 on its branch ${BRANCH} is merged`,
};
const OPEN: BranchFate = {_tag: "Live", because: `pull request #8572 on ${BRANCH} is open`};

/** A clean, quiet, detached tree level with the trunk, which the board says nothing about. */
const facts = (over: Partial<BoardFacts> = {}): BoardFacts => ({
	path: PATH,
	branch: null,
	locked: null,
	presence: {_tag: "Present"},
	uncommitted: {_tag: "Read", paths: 0},
	landing: {_tag: "Ancestor"},
	stranded: {_tag: "Read", commits: 0},
	liveness: {_tag: "Quiet"},
	fate: NO_BRANCH,
	...over,
});

const DIRTY = {uncommitted: {_tag: "Read", paths: 3}} as const;
const ORPHANS = {landing: {_tag: "Unlanded"}, stranded: {_tag: "Read", commits: 2}} as const;

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
		expect(isAgentWorktree("/repo/.claude/worktrees/desk-5173")).toBe(false);
	});

	it("refuses a bare `agent-` with no name after it", () => {
		expect(isAgentWorktree("/repo/.claude/worktrees/agent-")).toBe(false);
	});

	it("matches the directory, never a path that merely mentions it", () => {
		expect(isAgentWorktree("/repo/docs/.claude-worktrees-agent-notes.md")).toBe(false);
	});

	it("admits the harness's own naming wherever it sits — the 93 the sweep could not see", () => {
		expect(isAgentWorktree("/private/tmp/worktrees/slug-8520/pi-worktree-0036baa5-59da-s0-0")).toBe(
			true,
		);
		expect(
			isAgentWorktree("/Users/u/code/o/r/worktrees/batch/worktrees/pi-worktree-24e1-s0-0"),
		).toBe(true);
	});

	it("refuses a bare `pi-worktree-` and a parent that merely carries the name", () => {
		expect(isAgentWorktree("/private/tmp/pi-worktree-")).toBe(false);
		expect(isAgentWorktree("/private/tmp/pi-worktree-0036/checkout")).toBe(false);
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

	it("keeps a tree holding commits no ref reaches that the trunk does not carry", () => {
		const verdict = classify(facts(ORPHANS), TRUNK, NOBODY);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/2 commit\(s\) no branch, remote-tracking ref or tag reaches/);
	});

	it("keeps unreached commits whose landing could not be read — UNKNOWN is never 'landed'", () => {
		const verdict = classify(
			facts({...ORPHANS, landing: {_tag: "Unknown", reason: "no merge base"}}),
			TRUNK,
			NOBODY,
		);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/UNKNOWN: no merge base/);
	});

	it("keeps a tree whose ref reach could not be read — UNKNOWN is never 'reached'", () => {
		const verdict = classify(
			facts({landing: {_tag: "Unlanded"}, stranded: {_tag: "Unknown", reason: "bad object"}}),
			TRUNK,
			NOBODY,
		);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/UNKNOWN: bad object/);
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

	it("keeps a tree whose directory could not be read for any reason but absence", () => {
		const verdict = classify(
			facts({presence: {_tag: "Unknown", reason: "PermissionDenied: FileSystem.stat"}}),
			TRUNK,
			NOBODY,
		);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/still there is UNKNOWN: PermissionDenied/);
	});
});

describe("classify — a clean tree whose commits all outlive it", () => {
	it("removes it when the trunk does not carry its HEAD, under a license of its own", () => {
		const verdict = classify(facts({landing: {_tag: "Unlanded"}, branch: BRANCH}), TRUNK, NOBODY);
		expect(verdict).toMatchObject({_tag: "Remove", license: "ref-reached", salvage: null});
		expect(verdict.because).toMatch(/a branch, remote-tracking ref or tag reaches every commit/);
	});

	it("removes it when the trunk's answer could not be read at all", () => {
		expect(
			classify(facts({landing: {_tag: "Unknown", reason: "no merge base"}}), TRUNK, NOBODY),
		).toMatchObject({_tag: "Remove", license: "ref-reached"});
	});

	it("is settled by git alone, so the board is never owed for it", () => {
		expect(classifyGit(facts({landing: {_tag: "Unlanded"}}), TRUNK, NOBODY)?._tag).toBe("Remove");
		expect(classifyGit(facts(DIRTY), TRUNK, NOBODY)).toBeNull();
		expect(classifyGit(facts(ORPHANS), TRUNK, NOBODY)).toBeNull();
	});
});

describe("classify — a branch the board proves merged or closed", () => {
	it("removes a tree holding uncommitted paths, and names the branch they are committed onto", () => {
		const verdict = classify(facts({...DIRTY, branch: BRANCH, fate: ENDED}), TRUNK, NOBODY);
		expect(verdict).toMatchObject({
			_tag: "Remove",
			license: "branch-ended",
			salvage: {paths: 3, onto: BRANCH},
		});
		expect(verdict.because).toMatch(/is merged, so .*3 uncommitted path\(s\)/);
	});

	it("removes a tree holding commits no ref reaches", () => {
		expect(classify(facts({...ORPHANS, fate: ENDED}), TRUNK, NOBODY)).toMatchObject({
			_tag: "Remove",
			license: "branch-ended",
			salvage: null,
		});
	});

	it("never overrides the self, live, locked or unreadable arms", () => {
		const held = {...DIRTY, branch: BRANCH, fate: ENDED};
		for (const [over, self] of [
			[{}, new Set([PATH])],
			[{liveness: LIVE}, NOBODY],
			[{liveness: {_tag: "Unknown", reason: "denied"}}, NOBODY],
			[{locked: ""}, NOBODY],
			[{presence: {_tag: "Unknown", reason: "denied"}}, NOBODY],
			[{uncommitted: {_tag: "Unknown", reason: "not a git repository"}}, NOBODY],
		] as const) {
			expect(classify(facts({...held, ...over}), TRUNK, self)._tag).toBe("Keep");
		}
	});
});

describe("classify — what a tree holds keeps it while its branch is not proven finished", () => {
	it("keeps uncommitted paths on a live branch, naming the count and that it is live", () => {
		const verdict = classify(facts({...DIRTY, branch: BRANCH, fate: OPEN}), TRUNK, NOBODY);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(
			/3 uncommitted path\(s\), and its branch is live: pull request/,
		);
	});

	it("keeps them when the board could not be read, naming what was not proven", () => {
		const verdict = classify(
			facts({
				...DIRTY,
				branch: BRANCH,
				fate: {_tag: "Unproven", reason: "#8572 could not be read: HTTP 502"},
			}),
			TRUNK,
			NOBODY,
		);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/merged or closed is not proven: \S+ could not be read/);
	});

	// The founder's long-running desk: detached, dirty, months old, made by no lane. It holds no
	// branch, so there is nothing to ask the board, and nothing git says can release it.
	it("keeps a detached, dirty, long-lived tree no lane made", () => {
		const verdict = classify(facts({...DIRTY, branch: null, fate: NO_BRANCH}), TRUNK, NOBODY);
		expect(verdict._tag).toBe("Keep");
		expect(verdict.because).toMatch(/3 uncommitted path\(s\).*it holds no branch/);
	});
});

describe("fateOfPulls — what the pull requests on a branch prove", () => {
	const pull = (number: number, state: string, merged = false) => ({number, state, merged});

	it("is live on one open pull request, whatever closed ones sit beside it", () => {
		expect(fateOfPulls(BRANCH, [pull(8572, "closed", true), pull(8600, "open")])).toMatchObject({
			_tag: "Live",
		});
	});

	it("is ended by a merged one, and by one closed unmerged", () => {
		expect(fateOfPulls(BRANCH, [pull(8572, "closed", true)])).toMatchObject({
			_tag: "Ended",
			branch: BRANCH,
		});
		expect(fateOfPulls(BRANCH, [pull(8572, "closed")])).toMatchObject({
			_tag: "Ended",
			because: expect.stringMatching(/closed unmerged/),
		});
	});

	it("answers nothing for a branch with no pull request", () => {
		expect(fateOfPulls(BRANCH, [])).toBeNull();
	});
});

describe("ticketOf and fateOfTicket — the number a branch is named for", () => {
	it("reads a lane branch and an epic branch, and nothing else", () => {
		expect(ticketOf(BRANCH)).toBe(8572);
		expect(ticketOf("build/pr-9001-43cc4b51")).toBe(9001);
		expect(ticketOf("epic/8160")).toBe(8160);
		expect(ticketOf("umut/spike")).toBeNull();
		expect(ticketOf("main")).toBeNull();
	});

	it("ends the branch on a closed number and keeps it live on an open one", () => {
		expect(fateOfTicket("epic/8160", {number: 8160, state: "closed"})._tag).toBe("Ended");
		expect(fateOfTicket("epic/8160", {number: 8160, state: "open"})._tag).toBe("Live");
	});
});

describe("classify — a registration whose directory is gone is pruned, not kept", () => {
	it("prunes a registration the stat proved absent", () => {
		const verdict = classify(
			facts({presence: {_tag: "Gone", because: "its directory does not exist"}}),
			TRUNK,
			NOBODY,
		);
		expect(verdict).toEqual({_tag: "Prune", because: "its directory does not exist"});
	});

	it("prunes a LOCKED registration whose directory is gone — the lock guards no checkout", () => {
		const verdict = classify(
			facts({
				locked: "claude agent agent-a29e (pid 84894 start Sat Aug 29 03:59:36 2026)",
				presence: {_tag: "Gone", because: "its directory does not exist"},
			}),
			TRUNK,
			NOBODY,
		);
		expect(verdict._tag).toBe("Prune");
	});

	it("keeps the tree this run stands in even when its directory reads gone", () => {
		const verdict = classify(
			facts({presence: {_tag: "Gone", because: "its directory does not exist"}}),
			TRUNK,
			new Set([PATH]),
		);
		expect(verdict._tag).toBe("Keep");
	});
});

describe("classifyCheap — what a sweep settles before it pays for a git read", () => {
	it("leaves a present, quiet, unlocked tree open, so the git reads are owed", () => {
		expect(classifyCheap(facts(), NOBODY)).toBeNull();
	});

	it("settles a live tree, so no git read is owed for it", () => {
		expect(classifyCheap(facts({liveness: LIVE}), NOBODY)?._tag).toBe("Keep");
	});

	it("agrees with classify on every arm it answers", () => {
		for (const over of [
			{liveness: LIVE},
			{locked: ""},
			{presence: {_tag: "Gone", because: "gone"} as const},
			{presence: {_tag: "Unknown", reason: "denied"} as const},
		]) {
			expect(classifyCheap(facts(over), NOBODY)).toEqual(classify(facts(over), TRUNK, NOBODY));
		}
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
