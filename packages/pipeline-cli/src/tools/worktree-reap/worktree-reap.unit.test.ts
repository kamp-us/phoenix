import {assert, describe, it} from "@effect/vitest";
import {
	classifyCandidate,
	computeWorktreeReapPlan,
	isManagedAgentWorktree,
	parseAgentLockOwner,
	parseWorktreeList,
	type ReapCandidate,
} from "./worktree-reap.ts";

const MAIN = "/Users/dev/phoenix";
const wtPath = (id: string) => `${MAIN}/.claude/worktrees/${id}`;

/** A dead-session, clean, all-pushed candidate — the reapable shape. Override per case. */
const candidate = (over: Partial<ReapCandidate> = {}): ReapCandidate => ({
	path: wtPath("agent-dead"),
	branch: "umut/1234-thing",
	owner: {pid: 4242, alive: false},
	hasUncommitted: false,
	hasUnpushed: false,
	...over,
});

describe("isManagedAgentWorktree", () => {
	it("matches a path under .claude/worktrees/", () => {
		assert.isTrue(isManagedAgentWorktree(wtPath("agent-a")));
	});

	it("rejects the primary checkout and foreign trees", () => {
		assert.isFalse(isManagedAgentWorktree(MAIN));
		assert.isFalse(isManagedAgentWorktree("/Users/dev/wt-issue-99"));
		assert.isFalse(isManagedAgentWorktree(""));
	});

	it("normalizes backslash separators (windows-shaped path)", () => {
		assert.isTrue(isManagedAgentWorktree("C:\\Users\\dev\\phoenix\\.claude\\worktrees\\agent-a"));
	});
});

describe("parseAgentLockOwner — the session-presence signal (pid off the harness lock reason)", () => {
	it("extracts the owning pid from a harness crew-agent lock reason", () => {
		const owner = parseAgentLockOwner(
			"claude agent agent-aa838a5704e05b5b3 (pid 58975 start Fri Jul 24 06:51:03 2026)",
		);
		assert.deepStrictEqual(owner, {pid: 58975});
	});

	it("returns null for an unlocked tree (null reason) — owner unprovable", () => {
		assert.isNull(parseAgentLockOwner(null));
	});

	it("returns null for a locked-with-no-reason tree (empty string)", () => {
		assert.isNull(parseAgentLockOwner(""));
	});

	it("returns null for an operator's manual lock — never read a pid out of a foreign lock", () => {
		// A human `git worktree lock --reason "pinned for debugging (pid 999)"` must NOT be parsed as
		// a crew-agent owner, even though it contains a `pid` token: it lacks the `claude agent` prefix.
		assert.isNull(parseAgentLockOwner("pinned for debugging (pid 999)"));
		assert.isNull(parseAgentLockOwner("do not remove"));
	});

	it("returns null for a crew-agent lock with no parseable pid", () => {
		assert.isNull(parseAgentLockOwner("claude agent agent-x (started, no pid recorded)"));
	});

	it("rejects a non-positive / zero pid", () => {
		assert.isNull(parseAgentLockOwner("claude agent agent-x (pid 0 start now)"));
	});
});

describe("classifyCandidate — the #3754 safety policy (dead+clean → reap; dead+dirty → kept; live → spared)", () => {
	it("DEAD session + clean + all pushed → REAP (orphan reclaimed)", () => {
		const d = classifyCandidate(candidate());
		assert.strictEqual(d.kind, "reap");
	});

	it("LIVE session → SPARED even when the tree is clean (the ADR 0191 presence gate)", () => {
		const d = classifyCandidate(candidate({owner: {pid: 4242, alive: true}}));
		assert.deepStrictEqual(d, {kind: "spare", reason: "live-session"});
	});

	it("LIVE session with dirty work → still SPARED (liveness precedes the work checks)", () => {
		const d = classifyCandidate(
			candidate({owner: {pid: 4242, alive: true}, hasUncommitted: true, hasUnpushed: true}),
		);
		assert.deepStrictEqual(d, {kind: "spare", reason: "live-session"});
	});

	it("DEAD session + UNCOMMITTED work → KEEP-DIRTY, never reaped", () => {
		const d = classifyCandidate(candidate({hasUncommitted: true}));
		assert.deepStrictEqual(d, {kind: "keep-dirty", reason: "uncommitted"});
	});

	it("DEAD session + UNPUSHED commits → KEEP-DIRTY, never reaped (the #3754 observed case)", () => {
		const d = classifyCandidate(candidate({hasUnpushed: true}));
		assert.deepStrictEqual(d, {kind: "keep-dirty", reason: "unpushed"});
	});

	it("uncommitted is reported ahead of unpushed when both hold", () => {
		const d = classifyCandidate(candidate({hasUncommitted: true, hasUnpushed: true}));
		assert.deepStrictEqual(d, {kind: "keep-dirty", reason: "uncommitted"});
	});

	it("owner unprovable (null) → SPARED (owner-unknown), never reaped — can't prove orphaned", () => {
		const d = classifyCandidate(candidate({owner: null}));
		assert.deepStrictEqual(d, {kind: "spare", reason: "owner-unknown"});
	});

	it("owner unprovable wins even on a clean tree — no age fallback, no reap without a dead-session proof", () => {
		const d = classifyCandidate(
			candidate({owner: null, hasUncommitted: false, hasUnpushed: false}),
		);
		assert.strictEqual(d.kind, "spare");
	});

	it("non-managed path → SPARED (not-managed), never touched — even with a dead owner + clean tree", () => {
		const d = classifyCandidate(
			candidate({path: "/Users/dev/some/bespoke/wt", owner: {pid: 4242, alive: false}}),
		);
		assert.deepStrictEqual(d, {kind: "spare", reason: "not-managed"});
	});
});

describe("computeWorktreeReapPlan — partitions into reap / kept-dirty / spared", () => {
	it("routes each candidate to exactly one bucket", () => {
		const reapable = candidate({path: wtPath("agent-reap")});
		const dirty = candidate({path: wtPath("agent-dirty"), hasUncommitted: true});
		const unpushed = candidate({path: wtPath("agent-unpushed"), hasUnpushed: true});
		const live = candidate({path: wtPath("agent-live"), owner: {pid: 7, alive: true}});
		const unknown = candidate({path: wtPath("agent-unknown"), owner: null});
		const foreign = candidate({path: "/Users/dev/other-wt"});

		const plan = computeWorktreeReapPlan([reapable, dirty, unpushed, live, unknown, foreign]);

		assert.deepStrictEqual(
			plan.toReap.map((r) => r.worktree.path),
			[wtPath("agent-reap")],
		);
		assert.deepStrictEqual(
			plan.keptDirty.map((k) => [k.worktree.path, k.reason]),
			[
				[wtPath("agent-dirty"), "uncommitted"],
				[wtPath("agent-unpushed"), "unpushed"],
			],
		);
		assert.deepStrictEqual(
			plan.spared.map((s) => [s.worktree.path, s.reason]),
			[
				[wtPath("agent-live"), "live-session"],
				[wtPath("agent-unknown"), "owner-unknown"],
				["/Users/dev/other-wt", "not-managed"],
			],
		);
	});

	it("empty input → empty plan (fail-closed on zero scope: nothing reaped)", () => {
		const plan = computeWorktreeReapPlan([]);
		assert.deepStrictEqual(plan, {toReap: [], keptDirty: [], spared: []});
	});
});

describe("parseWorktreeList — preserves the lock reason (the age-based sweep discards it)", () => {
	it("captures path, HEAD, branch, and the crew-agent lock reason", () => {
		const porcelain = [
			"worktree /Users/dev/phoenix",
			"HEAD 0420fedbc175d8f2bfd4ada19acec6f729e3d5bc",
			"branch refs/heads/main",
			"",
			"worktree /Users/dev/phoenix/.claude/worktrees/agent-dead",
			"HEAD d904a06b086a2bfdda5862b6fa0165271a6832dc",
			"branch refs/heads/worktree-agent-dead",
			"locked claude agent agent-dead (pid 58975 start Fri Jul 24 06:51:03 2026)",
			"",
		].join("\n");

		const parsed = parseWorktreeList(porcelain);
		assert.strictEqual(parsed.length, 2);
		const [primary, agent] = parsed;
		assert.deepStrictEqual(primary, {
			path: "/Users/dev/phoenix",
			head: "0420fedbc175d8f2bfd4ada19acec6f729e3d5bc",
			branch: "main",
			bare: false,
			lockReason: null,
		});
		assert.strictEqual(
			agent?.lockReason,
			"claude agent agent-dead (pid 58975 start Fri Jul 24 06:51:03 2026)",
		);
	});

	it("distinguishes unlocked (null), locked-no-reason (''), and detached", () => {
		const porcelain = [
			"worktree /wt/detached-locked",
			"HEAD abc",
			"detached",
			"locked",
			"",
			"worktree /wt/plain",
			"HEAD def",
			"branch refs/heads/feature",
			"",
		].join("\n");

		const parsed = parseWorktreeList(porcelain);
		const [detachedLocked, plain] = parsed;
		assert.strictEqual(detachedLocked?.branch, null);
		assert.strictEqual(detachedLocked?.lockReason, "");
		assert.strictEqual(plain?.lockReason, null);
	});

	it("end-to-end: a locked dead-session block parses into a reapable candidate shape", () => {
		// The lock reason → owner pid path the command boundary walks, exercised purely.
		const parsed = parseWorktreeList(
			[
				"worktree /Users/dev/phoenix/.claude/worktrees/agent-dead",
				"HEAD d904a06b086a2bfdda5862b6fa0165271a6832dc",
				"branch refs/heads/worktree-agent-dead",
				"locked claude agent agent-dead (pid 4242 start Fri Jul 24 06:51:03 2026)",
			].join("\n"),
		);
		const block = parsed[0];
		if (block === undefined) throw new Error("expected one parsed worktree block");
		const owner = parseAgentLockOwner(block.lockReason);
		assert.deepStrictEqual(owner, {pid: 4242});
		// With a dead pid gathered at the boundary, this is the reapable classification.
		const d = classifyCandidate({
			path: block.path,
			branch: block.branch,
			owner: owner === null ? null : {...owner, alive: false},
			hasUncommitted: false,
			hasUnpushed: false,
		});
		assert.strictEqual(d.kind, "reap");
	});
});
