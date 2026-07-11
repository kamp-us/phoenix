import {assert, describe, it} from "@effect/vitest";
import {hasLeadingCd, inspectGitHeadMove, pinBash} from "./bash-pin.ts";

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

describe("pinBash — refuse a bare HEAD-moving git op in a guarded worktree (#1571)", () => {
	// (a) a bare HEAD-move from a guarded agent would escape to the shared primary → REFUSE
	it("refuses a bare `git checkout <sha>` (would detach the shared primary HEAD)", () => {
		const d = pinBash({worktreeRoot: WT, command: "git checkout 1a2b3c4"});
		assert.strictEqual(d.kind, "refuse");
		if (d.kind === "refuse") assert.match(d.reason, /git -C "\$WT"/);
	});
	it("refuses bare `git switch`, `git reset --hard`, and `git rebase`", () => {
		assert.strictEqual(pinBash({worktreeRoot: WT, command: "git switch main"}).kind, "refuse");
		assert.strictEqual(
			pinBash({worktreeRoot: WT, command: "git reset --hard origin/main"}).kind,
			"refuse",
		);
		assert.strictEqual(
			pinBash({worktreeRoot: WT, command: "git rebase origin/main"}).kind,
			"refuse",
		);
	});
	// #2030: `stash`/`merge` corrupt the shared primary's WORKING TREE (the review-doc
	// `git stash pop` + `reset --hard` incident) — same shared-checkout hazard, same refusal.
	it("refuses bare `git stash` / `git stash pop` and `git merge` (would corrupt the primary tree)", () => {
		assert.strictEqual(pinBash({worktreeRoot: WT, command: "git stash"}).kind, "refuse");
		assert.strictEqual(pinBash({worktreeRoot: WT, command: "git stash pop"}).kind, "refuse");
		assert.strictEqual(
			pinBash({worktreeRoot: WT, command: "git merge origin/main"}).kind,
			"refuse",
		);
	});
	it('allows the safe `git -C "$WT" stash pop` scoped form', () => {
		assert.strictEqual(
			pinBash({worktreeRoot: WT, command: 'git -C "$WT" stash pop'}).kind,
			"allow",
		);
	});

	// (b) the safe `git -C "$WT" …` form → ALLOW (scoped; `-C` overrides cwd, no pin needed)
	it('allows the safe `git -C "$WT" checkout FETCH_HEAD` form', () => {
		assert.strictEqual(
			pinBash({worktreeRoot: WT, command: 'git -C "$WT" checkout FETCH_HEAD'}).kind,
			"allow",
		);
	});
	it("allows a HEAD-move scoped by a literal path under the worktree root", () => {
		assert.strictEqual(
			pinBash({worktreeRoot: WT, command: `git -C ${WT} checkout FETCH_HEAD`}).kind,
			"allow",
		);
	});
	it('allows `git -C "$WORKTREE_ROOT" reset --hard` (env-var scope form)', () => {
		assert.strictEqual(
			pinBash({worktreeRoot: WT, command: 'git -C "$WORKTREE_ROOT" reset --hard FETCH_HEAD'}).kind,
			"allow",
		);
	});

	// (c) a worktree agent's cd-pinned command → unchanged (leading cd is honored as-is)
	it('leaves a `cd "$WT" && git checkout …` command as allow (its own cwd)', () => {
		assert.strictEqual(
			pinBash({worktreeRoot: WT, command: `cd "${WT}" && git checkout FETCH_HEAD`}).kind,
			"allow",
		);
	});

	// (d) a non-guarded / orchestrator context → NOT refused (the reattach `git checkout main` survives)
	it("does NOT refuse a bare HEAD-move when $WORKTREE_ROOT is unset (orchestrator reattach)", () => {
		assert.strictEqual(pinBash({worktreeRoot: "", command: "git checkout main"}).kind, "allow");
	});
	it("does NOT refuse a bare HEAD-move for a non-managed root (bare orchestrator shell)", () => {
		assert.strictEqual(
			pinBash({worktreeRoot: "/some/bespoke/wt", command: "git checkout main"}).kind,
			"allow",
		);
	});

	// (e) non-HEAD-moving git ops (status/log/fetch) → permitted (cd-pinned, never refused)
	it("does not refuse non-HEAD-moving git ops — status/log/fetch are cd-pinned, not refused", () => {
		for (const cmd of ["git status", "git log --oneline", "git fetch origin main"]) {
			const d = pinBash({worktreeRoot: WT, command: cmd});
			assert.strictEqual(d.kind, "rewrite", `${cmd} should be cd-pinned, not refused`);
			if (d.kind === "rewrite") assert.strictEqual(d.command, `cd "${WT}" && ${cmd}`);
		}
	});
	it("does not misfire on a HEAD-move keyword buried in a non-git command", () => {
		// `checkout` as an argument, not a git subcommand, must not trip the refusal
		assert.strictEqual(pinBash({worktreeRoot: WT, command: "echo checkout"}).kind, "rewrite");
	});
});

// ADR 0172 / #2454: when isolation was EXPECTED (coder/reviewer/shipper) but the harness no-op'd
// provisioning (#2440), $WORKTREE_ROOT is unset — which used to disarm the guard entirely and let
// the #2452/#2453 `git -C "$WT" checkout` primary-checkout detach through. isolationExpected closes it.
describe("pinBash — isolation expected but NO provisioned worktree (ADR 0172, #2453)", () => {
	it('refuses `git -C "$WT" checkout FETCH_HEAD` (the #2453 form) when root unset + isolation expected', () => {
		const d = pinBash({
			worktreeRoot: "",
			command: 'git -C "$WT" checkout FETCH_HEAD',
			isolationExpected: true,
		});
		assert.strictEqual(d.kind, "refuse");
		if (d.kind === "refuse") assert.match(d.reason, /NO provisioned worktree/);
	});
	it("refuses a bare `git checkout main` when root unset + isolation expected", () => {
		assert.strictEqual(
			pinBash({worktreeRoot: "", command: "git checkout main", isolationExpected: true}).kind,
			"refuse",
		);
	});
	it("refuses `git switch`/`reset`/`stash`/`merge` too (all HEAD-moving) when root unset + isolation expected", () => {
		for (const cmd of [
			"git switch main",
			"git reset --hard FETCH_HEAD",
			"git stash pop",
			"git merge origin/main",
			'git -C "$WORKTREE_ROOT" reset --hard FETCH_HEAD',
		]) {
			assert.strictEqual(
				pinBash({worktreeRoot: "", command: cmd, isolationExpected: true}).kind,
				"refuse",
				`${cmd} should refuse`,
			);
		}
	});
	it("does NOT over-refuse a non-head-move (git status / fetch / worktree add) when root unset + isolation expected", () => {
		// worktree add is the sanctioned self-provision op (not HEAD-moving) — never refuse it
		for (const cmd of [
			"git status",
			"git fetch origin main",
			"git worktree add -b br /tmp/wt FETCH_HEAD",
			"ls -la",
		]) {
			assert.strictEqual(
				pinBash({worktreeRoot: "", command: cmd, isolationExpected: true}).kind,
				"allow",
				`${cmd} should allow`,
			);
		}
	});
	it("still allows a bare HEAD-move when isolation was NOT expected (orchestrator/standalone — unchanged)", () => {
		assert.strictEqual(
			pinBash({worktreeRoot: "", command: 'git -C "$WT" checkout FETCH_HEAD'}).kind,
			"allow",
		);
		assert.strictEqual(
			pinBash({worktreeRoot: "", command: "git checkout main", isolationExpected: false}).kind,
			"allow",
		);
	});
	it('is unchanged for a genuinely provisioned (managed) worktree — `-C "$WT"` still allowed', () => {
		// isolation expected AND a real managed root: the safe scoped form is genuinely safe
		assert.strictEqual(
			pinBash({
				worktreeRoot: WT,
				command: 'git -C "$WT" checkout FETCH_HEAD',
				isolationExpected: true,
			}).kind,
			"allow",
		);
	});
});

describe("inspectGitHeadMove — the pure parse (branch-by-branch)", () => {
	it("flags a bare head-move as head-move + unscoped", () => {
		assert.deepStrictEqual(inspectGitHeadMove("git checkout 1a2b", WT), {
			isHeadMove: true,
			worktreeScoped: false,
		});
	});
	it("flags a -C worktree head-move as head-move + scoped", () => {
		assert.deepStrictEqual(inspectGitHeadMove('git -C "$WT" switch main', WT), {
			isHeadMove: true,
			worktreeScoped: true,
		});
	});
	it("does not flag a `-C <primary>` head-move as worktree-scoped (fail-closed)", () => {
		assert.deepStrictEqual(inspectGitHeadMove("git -C /main/checkout reset --hard", WT), {
			isHeadMove: true,
			worktreeScoped: false,
		});
	});
	it("does not flag a non-head-moving git op", () => {
		assert.deepStrictEqual(inspectGitHeadMove("git status", WT), {
			isHeadMove: false,
			worktreeScoped: false,
		});
	});
	it("does not flag a non-git command", () => {
		assert.deepStrictEqual(inspectGitHeadMove("ls -la", WT), {
			isHeadMove: false,
			worktreeScoped: false,
		});
	});
});
