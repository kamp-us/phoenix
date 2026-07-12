import {assert, describe, it} from "@effect/vitest";
import {decideReap, isManagedWorktree} from "./reap.ts";

const WT = "/Users/dev/code/phoenix/.claude/worktrees/wf_abc123";
const OTHER_WT = "/Users/dev/code/phoenix/.claude/worktrees/wf_nested999";

describe("isManagedWorktree", () => {
	it("recognizes the managed worktree layout", () => {
		assert.isTrue(isManagedWorktree(WT));
		assert.isFalse(isManagedWorktree("/some/bespoke/wt"));
		assert.isFalse(isManagedWorktree(""));
	});
});

describe("decideReap — the safe-worktree-prune rule (AC: clean → reap, dirty → refuse-and-keep)", () => {
	it("OWNER + CLEAN → reap (git worktree remove, no --force)", () => {
		const d = decideReap({worktreeRoot: WT, ownedWorktree: WT, isDirty: false});
		assert.strictEqual(d.kind, "reap");
	});

	it("OWNER + DIRTY → refuse-and-keep (NEVER --force; unpushed work is sacred)", () => {
		const d = decideReap({worktreeRoot: WT, ownedWorktree: WT, isDirty: true});
		assert.strictEqual(d.kind, "refuse");
	});

	it("a trailing slash on either side still matches the owner (path normalized)", () => {
		assert.strictEqual(
			decideReap({worktreeRoot: WT, ownedWorktree: `${WT}/`, isDirty: false}).kind,
			"reap",
		);
	});

	it("non-managed path → skip (the reaper only touches its own worktree)", () => {
		assert.strictEqual(
			decideReap({
				worktreeRoot: "/some/bespoke/wt",
				ownedWorktree: "/some/bespoke/wt",
				isDirty: false,
			}).kind,
			"skip",
		);
		assert.strictEqual(
			decideReap({worktreeRoot: "", ownedWorktree: "", isDirty: false}).kind,
			"skip",
		);
	});

	it("a dirty NON-managed path still skips, never reaps", () => {
		assert.strictEqual(
			decideReap({worktreeRoot: "/other", ownedWorktree: "/other", isDirty: true}).kind,
			"skip",
		);
	});
});

describe("decideReap — the #2798 owner gate (ownership from the PAYLOAD, not worktree state)", () => {
	it("NESTED-CHILD stop (owns a DIFFERENT worktree) → skip/KEEP the parent's live tree", () => {
		// A descendant that merely inherited $WORKTREE_ROOT=WT but owns its own OTHER_WT.
		const d = decideReap({worktreeRoot: WT, ownedWorktree: OTHER_WT, isDirty: false});
		assert.strictEqual(d.kind, "skip");
	});

	it("ownership UNPROVABLE (empty owned path) → skip/KEEP (fail-closed)", () => {
		const d = decideReap({worktreeRoot: WT, ownedWorktree: "", isDirty: false});
		assert.strictEqual(d.kind, "skip");
	});

	it("the owner gate PRECEDES the dirty check: a non-owner on a dirty tree → skip, not refuse", () => {
		// Proves the decision keys on the payload-derived owner, not on clean/dirty worktree state:
		// a non-owner is a plain no-op regardless of the tree's dirtiness.
		const d = decideReap({worktreeRoot: WT, ownedWorktree: OTHER_WT, isDirty: true});
		assert.strictEqual(d.kind, "skip");
	});

	it("OWNER on a clean leaked tree → reap (the legitimate reclaim still works)", () => {
		const d = decideReap({worktreeRoot: WT, ownedWorktree: WT, isDirty: false});
		assert.strictEqual(d.kind, "reap");
	});
});
