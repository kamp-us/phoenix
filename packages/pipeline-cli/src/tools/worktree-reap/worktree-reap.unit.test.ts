import {assert, describe, it} from "@effect/vitest";
import {
	classifyCandidate,
	computeWorktreeReapPlan,
	isManagedAgentWorktree,
	ownerPresence,
	parseAgentLockOwner,
	parseWorktreeList,
	presenceFromOwnerLiveness,
	type ReapCandidate,
} from "./worktree-reap.ts";

const MAIN = "/Users/dev/phoenix";
const wtPath = (id: string) => `${MAIN}/.claude/worktrees/${id}`;

/** A dead-session (via the lock), clean, all-pushed candidate — the reapable shape. Override per case. */
const candidate = (over: Partial<ReapCandidate> = {}): ReapCandidate => ({
	path: wtPath("agent-dead"),
	branch: "umut/1234-thing",
	lockOwner: {pid: 4242, alive: false},
	foreignLock: false,
	stampPresence: "unknown",
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
	it("extracts the owning pid from a harness agent lock reason", () => {
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
		// an agent owner, even though it contains a `pid` token: it lacks the `claude agent` prefix.
		assert.isNull(parseAgentLockOwner("pinned for debugging (pid 999)"));
		assert.isNull(parseAgentLockOwner("do not remove"));
	});

	it("returns null for an agent lock with no parseable pid", () => {
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
		const d = classifyCandidate(candidate({lockOwner: {pid: 4242, alive: true}}));
		assert.deepStrictEqual(d, {kind: "spare", reason: "live-session"});
	});

	it("LIVE session with dirty work → still SPARED (liveness precedes the work checks)", () => {
		const d = classifyCandidate(
			candidate({lockOwner: {pid: 4242, alive: true}, hasUncommitted: true, hasUnpushed: true}),
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
		const d = classifyCandidate(candidate({lockOwner: null}));
		assert.deepStrictEqual(d, {kind: "spare", reason: "owner-unknown"});
	});

	it("owner unprovable wins even on a clean tree — no age fallback, no reap without a dead-session proof", () => {
		const d = classifyCandidate(
			candidate({lockOwner: null, hasUncommitted: false, hasUnpushed: false}),
		);
		assert.strictEqual(d.kind, "spare");
	});

	it("non-managed path → SPARED (not-managed), never touched — even with a dead owner + clean tree", () => {
		const d = classifyCandidate(
			candidate({path: "/Users/dev/some/bespoke/wt", lockOwner: {pid: 4242, alive: false}}),
		);
		assert.deepStrictEqual(d, {kind: "spare", reason: "not-managed"});
	});
});

describe("presenceFromOwnerLiveness — only `dead` licenses action, only `unknown` is no-signal", () => {
	it("maps the sweep's four verdicts, reading a live LAUNCHER as alive (never a reap license)", () => {
		assert.strictEqual(presenceFromOwnerLiveness("dead"), "dead");
		assert.strictEqual(presenceFromOwnerLiveness("unknown"), "unknown");
		assert.strictEqual(presenceFromOwnerLiveness("alive"), "alive");
		// #4001's `launcher-alive` is uninformative about the OCCUPANT — but this verb only acts on
		// proven death, so reading it as alive is the correct fail-safe here, not the #4001 over-KEEP.
		assert.strictEqual(presenceFromOwnerLiveness("launcher-alive"), "alive");
	});
});

describe("ownerPresence — two signals: any alive wins, death needs positive proof", () => {
	const facts = (over: Partial<ReapCandidate> = {}) => {
		const c = candidate(over);
		return {lockOwner: c.lockOwner, foreignLock: c.foreignLock, stampPresence: c.stampPresence};
	};

	it("locked-only: the lock pid carries the verdict", () => {
		assert.strictEqual(ownerPresence(facts({stampPresence: "unknown"})), "dead");
		assert.strictEqual(
			ownerPresence(facts({lockOwner: {pid: 1, alive: true}, stampPresence: "unknown"})),
			"alive",
		);
	});

	it("stamped-only (the unlocked majority): the stamp carries the verdict", () => {
		assert.strictEqual(ownerPresence(facts({lockOwner: null, stampPresence: "dead"})), "dead");
		assert.strictEqual(ownerPresence(facts({lockOwner: null, stampPresence: "alive"})), "alive");
	});

	it("neither signal → unknown, never dead", () => {
		assert.strictEqual(
			ownerPresence(facts({lockOwner: null, stampPresence: "unknown"})),
			"unknown",
		);
	});

	it("agreeing signals → that verdict", () => {
		assert.strictEqual(ownerPresence(facts({stampPresence: "dead"})), "dead");
		assert.strictEqual(
			ownerPresence(facts({lockOwner: {pid: 1, alive: true}, stampPresence: "alive"})),
			"alive",
		);
	});

	it("CONFLICTING signals fail safe toward alive, in both directions", () => {
		// dead lock + live stamp, and live lock + dead stamp: a live reading always wins, because
		// being wrong about death destroys work while being wrong about life only leaks a tree.
		assert.strictEqual(
			ownerPresence(facts({lockOwner: {pid: 1, alive: false}, stampPresence: "alive"})),
			"alive",
		);
		assert.strictEqual(
			ownerPresence(facts({lockOwner: {pid: 1, alive: true}, stampPresence: "dead"})),
			"alive",
		);
	});

	it("a foreign (operator) lock suppresses both signals → unknown", () => {
		assert.strictEqual(
			ownerPresence(facts({foreignLock: true, lockOwner: null, stampPresence: "dead"})),
			"unknown",
		);
	});
});

describe("classifyCandidate — the #3989 stamp signal (the unlocked majority is finally classifiable)", () => {
	it("UNLOCKED but stamped, session provably dead, clean + pushed → REAP (the #3989 AC)", () => {
		const d = classifyCandidate(candidate({lockOwner: null, stampPresence: "dead"}));
		assert.deepStrictEqual(d, {kind: "reap", reason: "orphan-clean"});
	});

	it("unlocked + stamped-dead but DIRTY → KEEP-DIRTY, never reaped", () => {
		const d = classifyCandidate(
			candidate({lockOwner: null, stampPresence: "dead", hasUncommitted: true}),
		);
		assert.deepStrictEqual(d, {kind: "keep-dirty", reason: "uncommitted"});
	});

	it("unlocked + stamped-ALIVE → SPARED (live-session), clean tree or not", () => {
		const d = classifyCandidate(candidate({lockOwner: null, stampPresence: "alive"}));
		assert.deepStrictEqual(d, {kind: "spare", reason: "live-session"});
	});

	it("unlocked + UNSTAMPED (the pre-#3988 historical pile) → SPARED (owner-unknown)", () => {
		const d = classifyCandidate(candidate({lockOwner: null, stampPresence: "unknown"}));
		assert.deepStrictEqual(d, {kind: "spare", reason: "owner-unknown"});
	});

	it("harness-locked trees keep working: a dead lock pid still reaps with no stamp at all", () => {
		const d = classifyCandidate(candidate({lockOwner: {pid: 4242, alive: false}}));
		assert.deepStrictEqual(d, {kind: "reap", reason: "orphan-clean"});
	});

	it("live lock + dead stamp → SPARED (live-session): conflict never reaps", () => {
		const d = classifyCandidate(
			candidate({lockOwner: {pid: 7, alive: true}, stampPresence: "dead"}),
		);
		assert.deepStrictEqual(d, {kind: "spare", reason: "live-session"});
	});

	it("dead lock + live stamp → SPARED (live-session): conflict never reaps, other direction", () => {
		const d = classifyCandidate(
			candidate({lockOwner: {pid: 7, alive: false}, stampPresence: "alive"}),
		);
		assert.deepStrictEqual(d, {kind: "spare", reason: "live-session"});
	});

	it("an operator's foreign lock is SPARED even with a provably dead stamp — never unlocked", () => {
		const d = classifyCandidate(
			candidate({foreignLock: true, lockOwner: null, stampPresence: "dead"}),
		);
		assert.deepStrictEqual(d, {kind: "spare", reason: "foreign-lock"});
	});
});

describe("classifyCandidate — review-head trees join the presence system (#4004)", () => {
	/** A $TMPDIR-rooted throwaway review checkout, as `review-head materialize` creates it. */
	const reviewHead = (over: Partial<ReapCandidate> = {}): ReapCandidate =>
		candidate({
			path: "/var/folders/8f/tmp.aBcD1234/review-head-4004-xY9",
			branch: null,
			// A detached PR head is normally NOT reachable from origin/main while the PR is open —
			// the state that used to read as unpushed work.
			hasUnpushed: true,
			...over,
		});

	it("DEAD owner + clean → REAP, even though its detached head is not on origin/main", () => {
		// The head came off `pull/<pr>/head`, so it is on the remote by construction: the build-tree
		// unpushed gate does not apply, and without this the orphan would be kept forever.
		assert.deepStrictEqual(classifyCandidate(reviewHead()), {kind: "reap", reason: "orphan-clean"});
	});

	it("LIVE owner → SPARED by PRESENCE (never owner-unknown) — a reviewer is working in it", () => {
		const d = classifyCandidate(reviewHead({lockOwner: {pid: 4242, alive: true}}));
		assert.deepStrictEqual(d, {kind: "spare", reason: "live-session"});
	});

	it("UNLOCKED (no provable owner) → still SPARED owner-unknown — the lock is its only owner proof", () => {
		// No hook stamps a `$TMPDIR` tree, so signal 2 is permanently `unknown` for this class and an
		// unlocked one has NO signal at all (#3989's stamp never reaches it).
		const d = classifyCandidate(reviewHead({lockOwner: null, stampPresence: "unknown"}));
		assert.deepStrictEqual(d, {kind: "spare", reason: "owner-unknown"});
	});

	it("an operator's foreign lock on one is SPARED even with a dead pid — the #4169 pin still outranks", () => {
		const d = classifyCandidate(reviewHead({foreignLock: true, lockOwner: null}));
		assert.deepStrictEqual(d, {kind: "spare", reason: "foreign-lock"});
	});

	it("DEAD owner + UNCOMMITTED changes → KEEP-DIRTY: the recoverable-work guard still applies", () => {
		const d = classifyCandidate(reviewHead({hasUncommitted: true}));
		assert.deepStrictEqual(d, {kind: "keep-dirty", reason: "uncommitted"});
	});

	it("the unpushed exemption is scoped to the class — a BUILD tree is still kept as unpushed", () => {
		const d = classifyCandidate(candidate({hasUnpushed: true}));
		assert.deepStrictEqual(d, {kind: "keep-dirty", reason: "unpushed"});
	});

	it("a review-head-named path is scoped by BASENAME — a nested tree is not the class", () => {
		const d = classifyCandidate(
			reviewHead({path: "/var/folders/8f/tmp.aBcD1234/review-head-4004-xY9/nested"}),
		);
		assert.deepStrictEqual(d, {kind: "spare", reason: "not-managed"});
	});
});

describe("computeWorktreeReapPlan — partitions into reap / kept-dirty / spared", () => {
	it("routes each candidate to exactly one bucket", () => {
		const reapable = candidate({path: wtPath("agent-reap")});
		const dirty = candidate({path: wtPath("agent-dirty"), hasUncommitted: true});
		const unpushed = candidate({path: wtPath("agent-unpushed"), hasUnpushed: true});
		const live = candidate({path: wtPath("agent-live"), lockOwner: {pid: 7, alive: true}});
		const unknown = candidate({path: wtPath("agent-unknown"), lockOwner: null});
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
	it("captures path, HEAD, branch, and the agent lock reason", () => {
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
			lockOwner: owner === null ? null : {...owner, alive: false},
			foreignLock: false,
			stampPresence: "unknown",
			hasUncommitted: false,
			hasUnpushed: false,
		});
		assert.strictEqual(d.kind, "reap");
	});
});
