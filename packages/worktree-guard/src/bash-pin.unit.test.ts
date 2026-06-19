import {assert, describe, it} from "@effect/vitest";
import {hasLeadingCd, pinBash} from "./bash-pin.ts";

const WT = "/Users/dev/code/phoenix/.claude/worktrees/wf_abc123";

describe("hasLeadingCd", () => {
	it("detects a leading cd", () => {
		assert.isTrue(hasLeadingCd("cd /x && ls"));
		assert.isTrue(hasLeadingCd("  cd /x"));
		assert.isTrue(hasLeadingCd("cd"));
	});
	it("is false for a non-cd command (including `cdfoo`)", () => {
		assert.isFalse(hasLeadingCd("ls -la"));
		assert.isFalse(hasLeadingCd("cdfoo"));
		assert.isFalse(hasLeadingCd("git status"));
	});
});

describe("pinBash — pin to $WORKTREE_ROOT (AC: Bash calls no longer target the main checkout)", () => {
	it('prepends `cd "$WORKTREE_ROOT" &&` when there is no explicit cd', () => {
		const d = pinBash({worktreeRoot: WT, command: "git status"});
		assert.strictEqual(d.kind, "rewrite");
		if (d.kind === "rewrite") assert.strictEqual(d.command, `cd "${WT}" && git status`);
	});

	it("does NOT pin a command that already leads with cd", () => {
		const d = pinBash({worktreeRoot: WT, command: "cd packages/foo && pnpm test"});
		assert.strictEqual(d.kind, "allow");
	});

	it("allows an empty command (nothing to pin)", () => {
		assert.strictEqual(pinBash({worktreeRoot: WT, command: "   "}).kind, "allow");
	});
});

describe("pinBash — no-op when not a managed worktree agent (fail-open)", () => {
	it("allows when $WORKTREE_ROOT is empty", () => {
		assert.strictEqual(pinBash({worktreeRoot: "", command: "git status"}).kind, "allow");
	});
	it("allows when $WORKTREE_ROOT is a bespoke (non-layout) dir", () => {
		assert.strictEqual(
			pinBash({worktreeRoot: "/some/bespoke/wt", command: "git status"}).kind,
			"allow",
		);
	});
});
