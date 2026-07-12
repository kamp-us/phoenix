import {describe, expect, it} from "@effect/vitest";
import {
	type BashStagingInput,
	decideBashStagingAttribution,
	renderBashStagingNote,
} from "./bash-attribution.ts";

const input = (command: string, over: Partial<BashStagingInput> = {}): BashStagingInput => ({
	command,
	cwd: "/repo",
	onPrimaryCheckout: true,
	agentType: "engineering-manager",
	sessionId: "sess-1",
	worktreeRoot: "",
	at: "2026-07-12T00:00:00Z",
	...over,
});

describe("decideBashStagingAttribution — records bulk-staging commands (the #2778 vectors)", () => {
	it("records a stage-everything `git add -A`", () => {
		const d = decideBashStagingAttribution(input("git add -A"));
		expect(d.kind).toBe("record");
		if (d.kind === "record") {
			expect(d.record.kind).toBe("stage-all");
			expect(d.record.command).toBe("git add -A");
			expect(d.record.cwd).toBe("/repo");
			expect(d.record.onPrimaryCheckout).toBe(true);
		}
	});

	it("records `git add .`", () => {
		const d = decideBashStagingAttribution(input("git add ."));
		expect(d.kind).toBe("record");
	});

	it("records `git commit -a` (auto-stages tracked deletions)", () => {
		const d = decideBashStagingAttribution(input('git commit -am "wip"'));
		expect(d.kind).toBe("record");
		if (d.kind === "record") expect(d.record.kind).toBe("stage-all");
	});

	it("records `git rm -r --cached` and captures the control-plane path arg (the literal #2778 shape)", () => {
		const d = decideBashStagingAttribution(input("git rm -r --cached .claude"));
		expect(d.kind).toBe("record");
		if (d.kind === "record") {
			expect(d.record.kind).toBe("rm-cached");
			expect(d.record.controlPlanePathArgs).toContain(".claude");
		}
	});

	it("finds the staging op inside a chained command (`git status && git add -A`)", () => {
		const d = decideBashStagingAttribution(input("git status && git add -A"));
		expect(d.kind).toBe("record");
	});
});

describe("decideBashStagingAttribution — quiet on low-signal / non-staging commands", () => {
	it("is quiet on a plain `git add <one-path>` (a single explicit add is low-signal)", () => {
		expect(decideBashStagingAttribution(input("git add packages/x/index.ts")).kind).toBe("quiet");
	});

	it("is quiet on a plain `git commit` (no auto-stage flag)", () => {
		expect(decideBashStagingAttribution(input('git commit -m "msg"')).kind).toBe("quiet");
	});

	it("is quiet on `git commit --amend` (the `a` in amend must not read as -a)", () => {
		expect(decideBashStagingAttribution(input("git commit --amend --no-edit")).kind).toBe("quiet");
	});

	it("is quiet on non-git commands", () => {
		expect(decideBashStagingAttribution(input("ls -A")).kind).toBe("quiet");
		expect(decideBashStagingAttribution(input("rm --cached foo")).kind).toBe("quiet");
	});

	it("is quiet on `git status`", () => {
		expect(decideBashStagingAttribution(input("git status --porcelain")).kind).toBe("quiet");
	});
});

describe("decideBashStagingAttribution — carries severity + identity for attribution", () => {
	it("records the worktree severity + agent identity in the record", () => {
		const d = decideBashStagingAttribution(
			input("git add -A", {
				onPrimaryCheckout: false,
				agentType: "coder",
				sessionId: "sess-9",
				worktreeRoot: "/repo/.claude/worktrees/w1",
			}),
		);
		expect(d.kind).toBe("record");
		if (d.kind === "record") {
			expect(d.record.onPrimaryCheckout).toBe(false);
			expect(d.record.agentType).toBe("coder");
			expect(d.record.sessionId).toBe("sess-9");
			expect(renderBashStagingNote(d.record)).toContain("a linked worktree");
		}
	});

	it("renders a primary-checkout note LOUDLY", () => {
		const d = decideBashStagingAttribution(input("git add -A"));
		if (d.kind === "record") {
			expect(renderBashStagingNote(d.record)).toContain("the PRIMARY checkout");
			expect(renderBashStagingNote(d.record)).toContain("#2778");
		}
	});
});
