import {assert, describe, it} from "@effect/vitest";
import {guardEnterWorktree} from "./enter-guard.ts";

describe("guardEnterWorktree — hard-block a nested worktree (AC part c)", () => {
	it("BLOCKS EnterWorktree when $WORKTREE_ROOT is already set", () => {
		const d = guardEnterWorktree("/Users/dev/code/phoenix/.claude/worktrees/wf_abc123");
		assert.strictEqual(d.kind, "block");
	});

	it("allows EnterWorktree at the top level ($WORKTREE_ROOT unset)", () => {
		assert.strictEqual(guardEnterWorktree(undefined).kind, "allow");
		assert.strictEqual(guardEnterWorktree("").kind, "allow");
		assert.strictEqual(guardEnterWorktree("   ").kind, "allow");
	});
});
