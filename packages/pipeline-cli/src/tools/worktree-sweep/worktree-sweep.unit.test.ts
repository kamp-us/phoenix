import {assert, describe, it} from "@effect/vitest";
import {
	classifyWorktree,
	computeWorktreeSweepPlan,
	isManagedWorktree,
	isReviewHeadWorktree,
	parseWorktreeList,
	type WorktreeRecord,
} from "./worktree-sweep.ts";

const MAIN = "/Users/dev/phoenix";
const wtPath = (id: string) => `${MAIN}/.claude/worktrees/${id}`;
/** A $TMPDIR-rooted throwaway review checkout, as a review gate materializes it (#2785). */
const reviewHeadPath = (leaf: string) => `/var/folders/8f/tmp.aBcD1234/${leaf}`;

/** A review-head record: detached (no branch), clean, unlocked, idle — the leaked-and-reclaimable shape. */
const reviewRecord = (over: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
	path: reviewHeadPath("review-head-2815"),
	branch: null,
	prunable: false,
	isDirty: false,
	// A detached review head is often NOT reachable/merged (an open PR's head, pre-squash) — the
	// leaked class the merge gate can't reclaim. These fields are moot for review-head classification.
	reachableFromOriginMain: false,
	squashMergedToOriginMain: false,
	locked: false,
	staleAgentLock: false,
	recentlyActive: false,
	hasOpenPr: false,
	// The fixtures default to a PROVABLY-DEAD owner so each pre-#3943 case still exercises the
	// branch it was written for. The live/unknown owners are the explicit guard cases below.
	ownerLiveness: "dead",
	idleBeyondLauncherGrace: false,
	...over,
});

const record = (over: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
	path: wtPath("agent-clean"),
	branch: "umut/1234-thing",
	prunable: false,
	isDirty: false,
	reachableFromOriginMain: true,
	squashMergedToOriginMain: false,
	locked: false,
	staleAgentLock: false,
	recentlyActive: false,
	hasOpenPr: false,
	ownerLiveness: "dead",
	idleBeyondLauncherGrace: false,
	...over,
});

/**
 * The shipper-shaped state a live lane presents to the age-based signals (#3943): clean (a shipper
 * only reads), its PR just squash-merged onto `origin/main`, and mtime-idle (a >30min ship touches no
 * file in the tree). `locked: false` here is the reapable *fixture* state under test, NOT a claim
 * that a live tree is never locked — see `owner-liveness.ts` for what the lock gate does and does not
 * cover. Under these signals only owner presence tells a live lane apart from an orphan.
 */
const shipperShaped = (over: Partial<WorktreeRecord> = {}): WorktreeRecord =>
	record({
		branch: "usirin/ship-3913",
		isDirty: false,
		reachableFromOriginMain: false,
		squashMergedToOriginMain: true,
		locked: false,
		staleAgentLock: false,
		recentlyActive: false,
		hasOpenPr: false,
		...over,
	});

describe("isManagedWorktree", () => {
	it("matches a path under .claude/worktrees/", () => {
		assert.isTrue(isManagedWorktree(wtPath("agent-a")));
	});

	it("rejects the primary checkout", () => {
		assert.isFalse(isManagedWorktree(MAIN));
	});

	it("rejects an arbitrary sibling worktree outside .claude/worktrees/", () => {
		assert.isFalse(isManagedWorktree("/Users/dev/wt-issue-99"));
	});

	it("normalizes backslash separators (windows-shaped path)", () => {
		assert.isTrue(isManagedWorktree("C:\\Users\\dev\\phoenix\\.claude\\worktrees\\agent-a"));
	});

	it("does NOT classify a $TMPDIR review-head tree as a managed (.claude/worktrees) build tree", () => {
		assert.isFalse(isManagedWorktree(reviewHeadPath("review-head-2815")));
	});
});

describe("isReviewHeadWorktree", () => {
	it("matches each review gate's leaf (review-code / review-doc / review-skill)", () => {
		assert.isTrue(isReviewHeadWorktree(reviewHeadPath("review-head-2815")));
		assert.isTrue(isReviewHeadWorktree(reviewHeadPath("review-doc-head-2815")));
		assert.isTrue(isReviewHeadWorktree(reviewHeadPath("review-skill-head-2815")));
	});

	it("anchors to the BASENAME — a build tree under a review-head-named parent is not a review head", () => {
		assert.isFalse(isReviewHeadWorktree(`${wtPath("review-head-2815")}/agent-x`));
	});

	it("rejects the primary checkout and a normal build worktree", () => {
		assert.isFalse(isReviewHeadWorktree(MAIN));
		assert.isFalse(isReviewHeadWorktree(wtPath("agent-a")));
	});

	it("normalizes backslash separators (windows-shaped path)", () => {
		assert.isTrue(isReviewHeadWorktree("C:\\Users\\dev\\AppData\\Temp\\tmp.x\\review-head-9"));
	});
});

describe("classifyWorktree — review-head trees (#2785)", () => {
	it("RECLAIMS a leaked, idle, clean, unlocked review-head tree even though its head is unmerged", () => {
		const d = classifyWorktree(reviewRecord());
		assert.deepStrictEqual(d, {kind: "remove", reason: "review-head-idle"});
	});

	it("keeps a DIRTY review-head tree (liveness preserved — never nuke uncommitted work)", () => {
		const d = classifyWorktree(reviewRecord({isDirty: true}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "dirty"});
	});

	it("keeps a LOCKED review-head tree (an operator/agent pinned it — #2240 liveness preserved)", () => {
		const d = classifyWorktree(reviewRecord({locked: true}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "locked"});
	});

	it("RECLAIMS one whose lock is a STALE agent lock — a dead session's pin never pins forever", () => {
		// `review-head materialize` now locks every tree it creates (#4004). Were `locked` alone a
		// keep, that lock would pin each of them past its reviewer's death and re-open the #2785
		// unbounded leak — so a lock whose owning session is PROVEN dead does not keep.
		const d = classifyWorktree(reviewRecord({locked: true, staleAgentLock: true}));
		assert.deepStrictEqual(d, {kind: "remove", reason: "review-head-idle"});
	});

	it("keeps a stale-locked tree that is still RECENTLY ACTIVE — the idle gate outlives the lock gate", () => {
		const d = classifyWorktree(
			reviewRecord({locked: true, staleAgentLock: true, recentlyActive: true}),
		);
		assert.deepStrictEqual(d, {kind: "keep", reason: "recently-active"});
	});

	it("keeps a stale-locked tree that is DIRTY — recoverable work outranks every liveness signal", () => {
		const d = classifyWorktree(reviewRecord({locked: true, staleAgentLock: true, isDirty: true}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "dirty"});
	});

	it("keeps a RECENTLY-ACTIVE review-head tree (a review still running against the head — #2240)", () => {
		const d = classifyWorktree(reviewRecord({recentlyActive: true}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "recently-active"});
	});

	it("dirty wins over the reclaim (still kept, reported as dirty) even for a review-head tree", () => {
		const d = classifyWorktree(reviewRecord({isDirty: true, recentlyActive: false}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "dirty"});
	});
});

describe("classifyWorktree — KEEP branches (the safety cases)", () => {
	it("keeps the primary checkout (not-managed) even when clean + merged", () => {
		const d = classifyWorktree(record({path: MAIN, isDirty: false, reachableFromOriginMain: true}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "not-managed"});
	});

	it("keeps a DIRTY managed worktree even when its branch is merged (never --force)", () => {
		const d = classifyWorktree(record({isDirty: true, reachableFromOriginMain: true}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "dirty"});
	});

	it("keeps an UNMERGED managed worktree (protects a live agent's in-flight PR branch)", () => {
		const d = classifyWorktree(
			record({
				branch: "umut/1288-vote",
				isDirty: false,
				reachableFromOriginMain: false,
				squashMergedToOriginMain: false,
			}),
		);
		assert.deepStrictEqual(d, {kind: "keep", reason: "unmerged"});
	});

	it("keeps a DIRTY worktree even when its branch squash-merged (never --force discards work)", () => {
		const d = classifyWorktree(
			record({isDirty: true, reachableFromOriginMain: false, squashMergedToOriginMain: true}),
		);
		assert.deepStrictEqual(d, {kind: "keep", reason: "dirty"});
	});

	it("dirty wins over unmerged (still kept, reported as dirty)", () => {
		const d = classifyWorktree(record({isDirty: true, reachableFromOriginMain: false}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "dirty"});
	});

	it("keeps a detached, NOT-reachable worktree as unmerged", () => {
		const d = classifyWorktree(
			record({branch: null, isDirty: false, reachableFromOriginMain: false}),
		);
		assert.deepStrictEqual(d, {kind: "keep", reason: "unmerged"});
	});

	// The #2240 liveness guard: clean+merged is NOT sufficient — a live sibling lane is
	// routinely momentarily clean-and-on-main, so each liveness signal must veto the remove.
	it("keeps a LOCKED clean+merged worktree (an operator/agent pinned it)", () => {
		const d = classifyWorktree(record({locked: true, reachableFromOriginMain: true}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "locked"});
	});

	it("keeps a RECENTLY-ACTIVE clean+merged worktree (presumed a live lane)", () => {
		const d = classifyWorktree(record({recentlyActive: true, reachableFromOriginMain: true}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "recently-active"});
	});

	it("keeps a clean+merged worktree WITH an OPEN PR (an in-flight lane)", () => {
		const d = classifyWorktree(record({hasOpenPr: true, reachableFromOriginMain: true}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "open-pr"});
	});

	it("keeps a clean, squash-merged worktree that is still recently-active (live post-merge round)", () => {
		const d = classifyWorktree(
			record({
				recentlyActive: true,
				reachableFromOriginMain: false,
				squashMergedToOriginMain: true,
			}),
		);
		assert.deepStrictEqual(d, {kind: "keep", reason: "recently-active"});
	});

	it("dirty wins over a liveness signal (still kept, reported as dirty)", () => {
		const d = classifyWorktree(record({isDirty: true, locked: true, hasOpenPr: true}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "dirty"});
	});
});

// The defect these pin is OVER-reaping, so these are the load-bearing tests: a dead-owner case
// only proves the reap still works, while a live or unprovable owner reaching REMOVE is destroyed
// work. Deleting the `ownerLiveness` gate from `classifyWorktree` turns every case here red.
describe("classifyWorktree — owner-presence liveness (#3943, ADR 0191)", () => {
	it("KEEPS a LIVE owner's worktree in the exact shipper-shaped state that was reaped: clean + squash-merged + unlocked + idle", () => {
		const d = classifyWorktree(shipperShaped({ownerLiveness: "alive"}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "live-session"});
	});

	it("KEEPS an UNPROVABLE owner's worktree in that same shipper-shaped state — cannot prove dead is not dead", () => {
		const d = classifyWorktree(shipperShaped({ownerLiveness: "unknown"}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "owner-unknown"});
	});

	it("KEEPS a LIVE owner's clean, ancestor-merged worktree (presence beats the merge gate)", () => {
		const d = classifyWorktree(record({reachableFromOriginMain: true, ownerLiveness: "alive"}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "live-session"});
	});

	it("KEEPS a LIVE reviewer's review-head tree (the same mid-run removal, on the review class)", () => {
		const d = classifyWorktree(reviewRecord({ownerLiveness: "alive"}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "live-session"});
	});

	it("KEEPS an unstamped review-head tree whose owner is unprovable (leak the orphan, never the live tree)", () => {
		const d = classifyWorktree(reviewRecord({ownerLiveness: "unknown"}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "owner-unknown"});
	});

	it("reports DIRTY ahead of presence — a live owner's dirty tree is still kept, never --force", () => {
		const d = classifyWorktree(shipperShaped({isDirty: true, ownerLiveness: "alive"}));
		assert.deepStrictEqual(d, {kind: "keep", reason: "dirty"});
	});

	it("still PRUNES a gone-dir tree regardless of owner liveness (no working surface to pull away)", () => {
		const d = classifyWorktree(record({prunable: true, ownerLiveness: "alive"}));
		assert.deepStrictEqual(d, {kind: "remove", reason: "gone-dir"});
	});

	it("removes the shipper-shaped tree ONLY once its owner is provably dead", () => {
		const d = classifyWorktree(shipperShaped({ownerLiveness: "dead"}));
		assert.deepStrictEqual(d, {kind: "remove", reason: "squash-merged-clean"});
	});

	it("partitions a live and a dead sibling into kept vs removable in one plan", () => {
		const alive = shipperShaped({path: wtPath("agent-live"), ownerLiveness: "alive"});
		const dead = shipperShaped({path: wtPath("agent-dead"), ownerLiveness: "dead"});
		const plan = computeWorktreeSweepPlan([alive, dead]);
		assert.deepStrictEqual(
			plan.toRemove.map((r) => r.worktree.path),
			[dead.path],
		);
		assert.deepStrictEqual(
			plan.kept.map((k) => [k.worktree.path, k.reason]),
			[[alive.path, "live-session"]],
		);
	});
});

// The inverse defect of #3943: UNDER-reaping. A long-lived launcher pane spawns many short-lived
// subagent trees and stays alive for hours, so a launcher-keyed owner resolves live for every tree
// it ever created — during exactly the runs that generate orphans. These pin that such a tree
// becomes sweep-eligible on its own idle clock, without waiting for the pane to exit, while a live
// occupant still never reaches REMOVE.
describe("classifyWorktree — launcher-keyed ownership (#4001)", () => {
	// The case this issue exists for: launcher still running, occupant long finished.
	it("REMOVES a launcher-owned orphan once it is idle past the grace window — no waiting on the pane", () => {
		const d = classifyWorktree(
			shipperShaped({ownerLiveness: "launcher-alive", idleBeyondLauncherGrace: true}),
		);
		assert.deepStrictEqual(d, {kind: "remove", reason: "squash-merged-clean"});
	});

	it("KEEPS the same tree inside the grace window, under a reason distinct from live-session", () => {
		const d = classifyWorktree(
			shipperShaped({ownerLiveness: "launcher-alive", idleBeyondLauncherGrace: false}),
		);
		assert.deepStrictEqual(d, {kind: "keep", reason: "launcher-alive"});
	});

	// The #3943 asymmetry, unweakened: every gate that protected a live occupant still outranks the
	// launcher branch, so no path here can remove a tree someone is working in.
	it("never removes a launcher-owned tree the harness still LOCKS — occupancy outranks the grace window", () => {
		const d = classifyWorktree(
			shipperShaped({locked: true, ownerLiveness: "launcher-alive", idleBeyondLauncherGrace: true}),
		);
		assert.deepStrictEqual(d, {kind: "keep", reason: "locked"});
	});

	it("never removes a launcher-owned tree that is dirty or has an open PR, past grace or not", () => {
		assert.deepStrictEqual(
			classifyWorktree(
				shipperShaped({
					isDirty: true,
					ownerLiveness: "launcher-alive",
					idleBeyondLauncherGrace: true,
				}),
			),
			{kind: "keep", reason: "dirty"},
		);
		assert.deepStrictEqual(
			classifyWorktree(
				shipperShaped({
					hasOpenPr: true,
					ownerLiveness: "launcher-alive",
					idleBeyondLauncherGrace: true,
				}),
			),
			{kind: "keep", reason: "open-pr"},
		);
	});

	it("keeps an UNKNOWN owner past the grace window — the grace window is not an escape from fail-closed", () => {
		const d = classifyWorktree(
			shipperShaped({ownerLiveness: "unknown", idleBeyondLauncherGrace: true}),
		);
		assert.deepStrictEqual(d, {kind: "keep", reason: "owner-unknown"});
	});

	it("reclaims a launcher-owned review-head tree past grace, keeping the live-owner one", () => {
		const stale = reviewRecord({
			path: reviewHeadPath("review-head-4001"),
			ownerLiveness: "launcher-alive",
			idleBeyondLauncherGrace: true,
		});
		const live = reviewRecord({path: reviewHeadPath("review-head-4002"), ownerLiveness: "alive"});
		const plan = computeWorktreeSweepPlan([stale, live]);
		assert.deepStrictEqual(
			plan.toRemove.map((r) => [r.worktree.path, r.reason]),
			[[stale.path, "review-head-idle"]],
		);
		assert.deepStrictEqual(
			plan.kept.map((k) => [k.worktree.path, k.reason]),
			[[live.path, "live-session"]],
		);
	});

	// The near-silence this issue reports is a DIAGNOSABILITY failure as much as a reaping one: a
	// run that keeps everything must say WHY, and the three causes must not collapse into one label.
	it("labels the three keep-causes distinctly so a near-silent run is readable", () => {
		const plan = computeWorktreeSweepPlan([
			shipperShaped({path: wtPath("agent-occupied"), ownerLiveness: "alive"}),
			shipperShaped({path: wtPath("agent-launcher"), ownerLiveness: "launcher-alive"}),
			shipperShaped({path: wtPath("agent-unstamped"), ownerLiveness: "unknown"}),
		]);
		assert.deepStrictEqual(
			plan.kept.map((k) => k.reason),
			["live-session", "launcher-alive", "owner-unknown"],
		);
	});
});

describe("classifyWorktree — REMOVE branches (clean AND reachable)", () => {
	it("removes a clean, merged-branch worktree as merged-clean", () => {
		const d = classifyWorktree(record({branch: "umut/1234-thing"}));
		assert.deepStrictEqual(d, {kind: "remove", reason: "merged-clean"});
	});

	it("removes a clean, detached, reachable worktree as detached-reachable", () => {
		const d = classifyWorktree(
			record({branch: null, isDirty: false, reachableFromOriginMain: true}),
		);
		assert.deepStrictEqual(d, {kind: "remove", reason: "detached-reachable"});
	});

	// The #1328 case: a squash merge (ADR 0048) rewrites the branch's commits into one
	// new commit on origin/main, so the worktree's tip is NOT a commit-ancestor — yet its
	// content has already landed. Clean + content-merged ⇒ removable.
	it("removes a clean, squash-merged worktree as squash-merged-clean (not ancestor-reachable)", () => {
		const d = classifyWorktree(
			record({
				branch: "umut/1234-thing",
				isDirty: false,
				reachableFromOriginMain: false,
				squashMergedToOriginMain: true,
			}),
		);
		assert.deepStrictEqual(d, {kind: "remove", reason: "squash-merged-clean"});
	});

	it("ancestor-reachability wins over the squash signal (reported as merged-clean)", () => {
		const d = classifyWorktree(
			record({reachableFromOriginMain: true, squashMergedToOriginMain: true}),
		);
		assert.deepStrictEqual(d, {kind: "remove", reason: "merged-clean"});
	});
});

describe("classifyWorktree — gone-dir prune (#3654)", () => {
	it("prunes a gone-dir MANAGED tree (working dir missing → reap the stale metadata)", () => {
		const d = classifyWorktree(record({prunable: true}));
		assert.deepStrictEqual(d, {kind: "remove", reason: "gone-dir"});
	});

	it("prunes a gone-dir FOREIGN tree too — prunable wins over not-managed (the cross-session pile)", () => {
		const d = classifyWorktree(record({path: "/Users/dev/scratchpad/wt-3030", prunable: true}));
		assert.deepStrictEqual(d, {kind: "remove", reason: "gone-dir"});
	});

	it("prunable wins over a fail-safe dirty flag (the working dir is gone — nothing on disk to strand)", () => {
		// A gone-dir tree can't be `git status`ed, so the impure shell reads dirty=true fail-safe;
		// prunable is checked FIRST so the metadata is still reaped (the branch ref survives a prune).
		const d = classifyWorktree(record({prunable: true, isDirty: true}));
		assert.deepStrictEqual(d, {kind: "remove", reason: "gone-dir"});
	});

	it("keeps a still-present (not-prunable) foreign tree — a live human worktree is never reaped", () => {
		const d = classifyWorktree(
			record({
				path: "/Users/dev/scratchpad/wt-live",
				prunable: false,
				reachableFromOriginMain: true,
			}),
		);
		assert.deepStrictEqual(d, {kind: "keep", reason: "not-managed"});
	});
});

describe("computeWorktreeSweepPlan — partition", () => {
	it("partitions a mixed pile into removable + kept-with-reason", () => {
		const records: ReadonlyArray<WorktreeRecord> = [
			record({path: MAIN, branch: "main"}), // not-managed
			record({path: wtPath("a"), branch: "umut/1-done"}), // merged-clean → remove
			record({path: wtPath("b"), isDirty: true}), // dirty → keep
			record({path: wtPath("c"), reachableFromOriginMain: false}), // unmerged → keep
			record({path: wtPath("d"), branch: null, reachableFromOriginMain: true}), // detached-reachable → remove
			// squash-merged-and-clean: tip not an ancestor, but content landed → remove (#1328)
			record({
				path: wtPath("e"),
				branch: "umut/2-squashed",
				reachableFromOriginMain: false,
				squashMergedToOriginMain: true,
			}),
		];
		const plan = computeWorktreeSweepPlan(records);
		assert.deepStrictEqual(
			new Set(plan.toRemove.map((p) => p.worktree.path)),
			new Set([wtPath("a"), wtPath("d"), wtPath("e")]),
		);
		assert.strictEqual(plan.kept.length, 3);
		const keepReason = (path: string) => plan.kept.find((k) => k.worktree.path === path)?.reason;
		assert.strictEqual(keepReason(MAIN), "not-managed");
		assert.strictEqual(keepReason(wtPath("b")), "dirty");
		assert.strictEqual(keepReason(wtPath("c")), "unmerged");
	});

	it("partitions a mixed pile of build + review-head trees (both classes, liveness preserved)", () => {
		const records: ReadonlyArray<WorktreeRecord> = [
			record({path: wtPath("a"), branch: "umut/1-done"}), // build, merged-clean → remove
			reviewRecord({path: reviewHeadPath("review-head-10")}), // leaked idle review head → remove
			reviewRecord({path: reviewHeadPath("review-doc-head-11"), recentlyActive: true}), // live review → keep
			reviewRecord({path: reviewHeadPath("review-skill-head-12"), isDirty: true}), // dirty review head → keep
			reviewRecord({path: reviewHeadPath("review-head-13"), locked: true}), // locked review head → keep
		];
		const plan = computeWorktreeSweepPlan(records);
		assert.deepStrictEqual(
			new Set(plan.toRemove.map((p) => p.worktree.path)),
			new Set([wtPath("a"), reviewHeadPath("review-head-10")]),
		);
		const removeReason = (path: string) =>
			plan.toRemove.find((r) => r.worktree.path === path)?.reason;
		assert.strictEqual(removeReason(reviewHeadPath("review-head-10")), "review-head-idle");
		const keepReason = (path: string) => plan.kept.find((k) => k.worktree.path === path)?.reason;
		assert.strictEqual(keepReason(reviewHeadPath("review-doc-head-11")), "recently-active");
		assert.strictEqual(keepReason(reviewHeadPath("review-skill-head-12")), "dirty");
		assert.strictEqual(keepReason(reviewHeadPath("review-head-13")), "locked");
	});

	it("partitions gone-dir trees (managed + foreign) into removable alongside a merged build tree", () => {
		const records: ReadonlyArray<WorktreeRecord> = [
			record({path: wtPath("a"), branch: "umut/1-done"}), // merged-clean → remove
			record({path: wtPath("gone-managed"), prunable: true}), // gone-dir → remove
			record({path: "/Users/dev/scratchpad/wt-3030", prunable: true}), // gone-dir foreign → remove
			record({path: wtPath("live"), reachableFromOriginMain: false}), // unmerged → keep
		];
		const plan = computeWorktreeSweepPlan(records);
		const removeReason = (path: string) =>
			plan.toRemove.find((r) => r.worktree.path === path)?.reason;
		assert.strictEqual(removeReason(wtPath("gone-managed")), "gone-dir");
		assert.strictEqual(removeReason("/Users/dev/scratchpad/wt-3030"), "gone-dir");
		assert.strictEqual(removeReason(wtPath("a")), "merged-clean");
		assert.strictEqual(plan.kept.length, 1);
		assert.strictEqual(plan.kept[0]?.reason, "unmerged");
	});

	it("an empty list yields an empty plan", () => {
		assert.deepStrictEqual(computeWorktreeSweepPlan([]), {toRemove: [], kept: []});
	});

	it("never removes when every managed worktree is dirty or unmerged", () => {
		const records: ReadonlyArray<WorktreeRecord> = [
			record({path: wtPath("a"), isDirty: true}),
			record({path: wtPath("b"), reachableFromOriginMain: false}),
		];
		const plan = computeWorktreeSweepPlan(records);
		assert.strictEqual(plan.toRemove.length, 0);
		assert.strictEqual(plan.kept.length, 2);
	});
});

describe("parseWorktreeList", () => {
	it("parses a primary + branch + detached + bare set", () => {
		const porcelain = [
			`worktree ${MAIN}`,
			"HEAD aaaa1111",
			"branch refs/heads/main",
			"",
			`worktree ${wtPath("agent-x")}`,
			"HEAD bbbb2222",
			"branch refs/heads/umut/1234-thing",
			"",
			`worktree ${wtPath("agent-y")}`,
			"HEAD cccc3333",
			"detached",
			"",
			`worktree ${MAIN}/some-bare`,
			"bare",
			"",
		].join("\n");
		const parsed = parseWorktreeList(porcelain);
		assert.strictEqual(parsed.length, 4);
		assert.deepStrictEqual(parsed[0], {
			path: MAIN,
			head: "aaaa1111",
			branch: "main",
			bare: false,
			locked: false,
			lockReason: null,
			prunable: false,
		});
		assert.strictEqual(parsed[1]?.branch, "umut/1234-thing");
		assert.strictEqual(parsed[2]?.branch, null);
		assert.strictEqual(parsed[2]?.head, "cccc3333");
		assert.isTrue(parsed[3]?.bare);
	});

	it("captures a locked worktree", () => {
		const porcelain = [
			`worktree ${wtPath("agent-z")}`,
			"HEAD dddd4444",
			"branch refs/heads/umut/9-x",
			"locked some reason",
			"",
		].join("\n");
		const parsed = parseWorktreeList(porcelain);
		assert.strictEqual(parsed.length, 1);
		assert.isTrue(parsed[0]?.locked);
		assert.strictEqual(parsed[0]?.lockReason, "some reason");
	});

	it("keeps the lock REASON — it carries the owning session's pid (#4004)", () => {
		const reason = "claude agent review-head-4004 (pid 58975 start 2026-07-25T23:48:53.000Z)";
		const parsed = parseWorktreeList(
			[
				`worktree /var/folders/8f/tmp.x/review-head-4004-aBc`,
				"HEAD dddd4444",
				"detached",
				`locked ${reason}`,
				"",
			].join("\n"),
		);
		assert.strictEqual(parsed[0]?.lockReason, reason);
	});

	it("distinguishes locked-with-no-reason ('') from unlocked (null)", () => {
		const parsed = parseWorktreeList(
			[`worktree ${wtPath("agent-z")}`, "HEAD dddd4444", "detached", "locked", ""].join("\n"),
		);
		assert.isTrue(parsed[0]?.locked);
		assert.strictEqual(parsed[0]?.lockReason, "");
	});

	it("captures a prunable (gone-dir) worktree — #3654", () => {
		const porcelain = [
			`worktree ${wtPath("gone")}`,
			"HEAD eeee5555",
			"detached",
			"prunable gitdir file points to non-existent location",
			"",
		].join("\n");
		const parsed = parseWorktreeList(porcelain);
		assert.strictEqual(parsed.length, 1);
		assert.isTrue(parsed[0]?.prunable);
		assert.isFalse(parsed[0]?.locked);
	});

	it("a non-prunable block reads prunable=false", () => {
		const parsed = parseWorktreeList(
			[`worktree ${wtPath("live")}`, "HEAD ffff6666", "branch refs/heads/umut/9-x", ""].join("\n"),
		);
		assert.isFalse(parsed[0]?.prunable);
	});

	it("tolerates a trailing block with no terminating blank line", () => {
		const porcelain = [
			`worktree ${wtPath("agent-x")}`,
			"HEAD bbbb2222",
			"branch refs/heads/umut/1234-thing",
		].join("\n");
		const parsed = parseWorktreeList(porcelain);
		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0]?.path, wtPath("agent-x"));
	});

	it("returns empty for empty input", () => {
		assert.deepStrictEqual(parseWorktreeList(""), []);
	});
});
