import {assert, describe, it} from "@effect/vitest";
import {decideReap, isManagedWorktree} from "./reap.ts";

const WT = "/Users/dev/code/phoenix/.claude/worktrees/wf_abc123";

describe("isManagedWorktree", () => {
	it("recognizes the managed worktree layout", () => {
		assert.isTrue(isManagedWorktree(WT));
		assert.isFalse(isManagedWorktree("/some/bespoke/wt"));
		assert.isFalse(isManagedWorktree(""));
	});
});

describe("decideReap — the safe-worktree-prune rule (AC: clean → reap, dirty → refuse-and-keep)", () => {
	it("CLEAN → reap (git worktree remove, no --force)", () => {
		const d = decideReap({worktreeRoot: WT, isDirty: false});
		assert.strictEqual(d.kind, "reap");
	});

	it("DIRTY → refuse-and-keep (NEVER --force; unpushed work is sacred)", () => {
		const d = decideReap({worktreeRoot: WT, isDirty: true});
		assert.strictEqual(d.kind, "refuse");
	});

	it("non-managed path → skip (the reaper only touches its own worktree)", () => {
		assert.strictEqual(decideReap({worktreeRoot: "/some/bespoke/wt", isDirty: false}).kind, "skip");
		assert.strictEqual(decideReap({worktreeRoot: "", isDirty: false}).kind, "skip");
	});

	it("a dirty NON-managed path still skips, never reaps", () => {
		assert.strictEqual(decideReap({worktreeRoot: "/other", isDirty: true}).kind, "skip");
	});
});
