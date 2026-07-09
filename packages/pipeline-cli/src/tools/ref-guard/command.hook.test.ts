import {execFile, execFileSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {REFUSE_EXIT_CODE} from "./command.ts";

// `pipeline-cli ref-guard reference-transaction <state>` reads git's ref-update lines
// off stdin. These tests drive the real command against real git ref transactions —
// grounding the guard's behavior in actual git `reference-transaction` semantics, not a
// modeled stub (CLAUDE.md: ground platform-behavior claims in the real platform).
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

// Every test here spawns `node bin.ts` through a REAL git ref-transaction, and git ≥ 2.45 (CI/prod
// runs 2.55) fires the `reference-transaction` hook once per state (preparing/prepared/committed) AND
// again for the AUTO_MERGE ref of a `checkout` — several node cold-starts per git op. On CI that blows
// vitest's 5000ms default (the #2415 timeouts). A generous suite-level timeout keeps the real-git
// tripwires green on the deployed git without weakening what they assert.
const HOOK_TEST_TIMEOUT = 60_000;

interface RunResult {
	readonly code: number;
	readonly stderr: string;
}

/** Run the guard with a given transaction state + stdin body, in a given cwd (a git repo). */
const runGuard = (state: string, stdin: string, cwd: string): Promise<RunResult> =>
	new Promise((resolve) => {
		const child = execFile(
			"node",
			[BIN, "ref-guard", "reference-transaction", state],
			{cwd},
			(error, _stdout, stderr) => {
				const code =
					error && typeof (error as {code?: unknown}).code === "number"
						? (error as {code: number}).code
						: 0;
				resolve({code, stderr});
			},
		);
		child.stdin?.end(stdin);
	});

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, {cwd, encoding: "utf8"}).trim();

const ZERO = "0000000000000000000000000000000000000000";

/**
 * A local repo with an `origin` remote whose `main` sits one commit AHEAD of the local
 * `main`, so we can craft both a fast-forward update (local main → origin/main, allow)
 * and a diverging update (local main → a sibling commit off the shared base, refuse).
 */
interface Fixture {
	readonly dir: string;
	readonly base: string; // shared base commit both origin/main and the divergent commit descend from
	readonly originTip: string; // origin/main's tip (a fast-forward of base)
	readonly divergent: string; // a commit off base that is NOT an ancestor of origin/main
}

let fx: Fixture;

const commitEmpty = (dir: string, msg: string): string => {
	git(dir, "commit", "--allow-empty", "-q", "-m", msg);
	return git(dir, "rev-parse", "HEAD");
};

beforeAll(() => {
	const root = mkdtempSync(join(tmpdir(), "ref-guard-"));
	const originDir = join(root, "origin.git");
	const dir = join(root, "clone");

	// A bare origin with main = base → originTip.
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", originDir]);
	const seed = join(root, "seed");
	execFileSync("git", ["init", "-q", "-b", "main", seed]);
	git(seed, "config", "user.email", "t@t");
	git(seed, "config", "user.name", "t");
	const base = commitEmpty(seed, "base");
	const originTip = commitEmpty(seed, "origin-ahead");
	execFileSync("git", ["remote", "add", "origin", originDir], {cwd: seed});
	execFileSync("git", ["push", "-q", "origin", "main"], {cwd: seed});

	// The working clone: main at base, origin/main fetched at originTip.
	execFileSync("git", ["clone", "-q", "-b", "main", originDir, dir]);
	git(dir, "config", "user.email", "t@t");
	git(dir, "config", "user.name", "t");
	// Reset local main back to base so a move to originTip is a real fast-forward.
	git(dir, "reset", "-q", "--hard", base);
	// A divergent commit off base (a sibling of origin-ahead) — NOT an ancestor of origin/main.
	const divergent = commitEmpty(dir, "divergent-off-base");
	git(dir, "reset", "-q", "--hard", base);

	fx = {dir, base, originTip, divergent};
	// stash the root for cleanup
	(fx as {cleanupRoot?: string}).cleanupRoot = root;
});

afterAll(() => {
	const root = (fx as {cleanupRoot?: string}).cleanupRoot;
	if (root) rmSync(root, {recursive: true, force: true});
});

describe("ref-guard reference-transaction — real git facts", {timeout: HOOK_TEST_TIMEOUT}, () => {
	it("REFUSES a diverging refs/heads/main move (non-fast-forward of origin/main) in 'prepared'", async () => {
		const stdin = `${fx.base} ${fx.divergent} refs/heads/main\n`;
		const {code, stderr} = await runGuard("prepared", stdin, fx.dir);
		assert.strictEqual(code, REFUSE_EXIT_CODE);
		assert.include(stderr, "DIVERGING");
	});

	it("ALLOWS a fast-forward refs/heads/main move (→ origin/main tip)", async () => {
		const stdin = `${fx.base} ${fx.originTip} refs/heads/main\n`;
		const {code} = await runGuard("prepared", stdin, fx.dir);
		assert.strictEqual(code, 0);
	});

	it("ALLOWS a move whose new tip == origin/main (in sync)", async () => {
		const stdin = `${fx.divergent} ${fx.originTip} refs/heads/main\n`;
		const {code} = await runGuard("prepared", stdin, fx.dir);
		assert.strictEqual(code, 0);
	});

	it("ALLOWS an off-main ref update regardless of divergence (out of scope)", async () => {
		const stdin = `${fx.base} ${fx.divergent} refs/heads/feature\n`;
		const {code} = await runGuard("prepared", stdin, fx.dir);
		assert.strictEqual(code, 0);
	});

	it("REFUSES deleting refs/heads/main (new all-zeroes)", async () => {
		const stdin = `${fx.originTip} ${ZERO} refs/heads/main\n`;
		const {code, stderr} = await runGuard("prepared", stdin, fx.dir);
		assert.strictEqual(code, REFUSE_EXIT_CODE);
		assert.include(stderr, "DELETE");
	});

	it("does NOT refuse in 'committed' state even for a divergence (exit honored only in prepared)", async () => {
		const stdin = `${fx.base} ${fx.divergent} refs/heads/main\n`;
		const {code} = await runGuard("committed", stdin, fx.dir);
		assert.strictEqual(code, 0);
	});

	it("does NOT refuse in 'aborted' state", async () => {
		const stdin = `${fx.base} ${fx.divergent} refs/heads/main\n`;
		const {code} = await runGuard("aborted", stdin, fx.dir);
		assert.strictEqual(code, 0);
	});

	it("allows an empty transaction (no queued updates)", async () => {
		const {code} = await runGuard("prepared", "", fx.dir);
		assert.strictEqual(code, 0);
	});
});

// The decisive end-to-end test the acceptance criteria demand: install the
// reference-transaction hook (wired EXACTLY as lefthook.yml does — exit 3 → abort) into a
// real repo, then perform a BARE git ref-move that goes through NO pipeline command. If the
// guard only fired on CLI-invoked moves it would be theater with the #1571 hole; this proves
// git's own ref boundary fires the hook and the guard aborts the transaction. We drive
// `git update-ref refs/heads/main` (a bare ref-transaction) rather than `git branch -f main`
// because git refuses a `-f` on the CURRENTLY-checked-out branch before any hook runs — the
// incident's `branch: Reset to HEAD` was a checkout-B/reset on the checked-out branch, of
// which update-ref is the minimal ref-transaction form.
describe("ref-guard — installed reference-transaction hook fires on a BARE git ref-move (no pipeline command)", {
	timeout: HOOK_TEST_TIMEOUT,
}, () => {
	// Mirror the lefthook.yml wiring EXACTLY: `|| status=$?` (never a bare call, so an
	// inherited `set -e` can't abort as a side effect) + abort ONLY on the dedicated refuse
	// code 3; every other non-zero (CLI absent / crash) fail-opens. `cmd` is the guard
	// invocation — parameterized so the CLI-unavailable test can point it at a missing bin.
	const hookBody = (cmd: string): string =>
		[
			"#!/bin/sh",
			"status=0",
			`${cmd} || status=$?`,
			'[ "$status" -eq 3 ] && exit 1',
			"exit 0",
			"",
		].join("\n");

	const guardCmd = (bin: string): string => `node "${bin}" ref-guard reference-transaction "$1"`;

	const installHook = (repoDir: string, cmd: string = guardCmd(BIN)): void => {
		const hookPath = join(repoDir, ".git", "hooks", "reference-transaction");
		writeFileSync(hookPath, hookBody(cmd), {mode: 0o755});
	};

	it("aborts a bare `git update-ref refs/heads/main <divergent>` — main is held at its old tip", () => {
		installHook(fx.dir);
		let aborted = false;
		try {
			execFileSync("git", ["update-ref", "refs/heads/main", fx.divergent], {
				cwd: fx.dir,
				stdio: "pipe",
			});
		} catch {
			aborted = true; // git exits non-zero: "ref updates aborted by hook"
		}
		rmSync(join(fx.dir, ".git", "hooks", "reference-transaction"), {force: true});
		assert.isTrue(aborted, "the bare update-ref should be aborted by the hook");
		assert.strictEqual(
			git(fx.dir, "rev-parse", "refs/heads/main"),
			fx.base,
			"main must still point at its pre-move tip (the force-move was refused)",
		);
	});

	it("allows a bare `git update-ref refs/heads/main <origin-tip>` (a fast-forward)", () => {
		// reset main to base, then fast-forward it to origin/main via a bare update-ref.
		git(fx.dir, "update-ref", "refs/heads/main", fx.base);
		installHook(fx.dir);
		let ok = true;
		try {
			execFileSync("git", ["update-ref", "refs/heads/main", fx.originTip], {
				cwd: fx.dir,
				stdio: "pipe",
			});
		} catch {
			ok = false;
		}
		rmSync(join(fx.dir, ".git", "hooks", "reference-transaction"), {force: true});
		assert.isTrue(ok, "a fast-forward update-ref should be allowed");
		assert.strictEqual(git(fx.dir, "rev-parse", "refs/heads/main"), fx.originTip);
		git(fx.dir, "update-ref", "refs/heads/main", fx.base); // restore fixture
	});

	it("does NOT block a bare ref-move of an off-main (worktree feature) branch", () => {
		installHook(fx.dir);
		let ok = true;
		try {
			execFileSync("git", ["update-ref", "refs/heads/umut/feature", fx.divergent], {
				cwd: fx.dir,
				stdio: "pipe",
			});
		} catch {
			ok = false;
		}
		rmSync(join(fx.dir, ".git", "hooks", "reference-transaction"), {force: true});
		assert.isTrue(
			ok,
			"an off-main branch ref-move must not be blocked (no false-positive on coders)",
		);
		assert.strictEqual(git(fx.dir, "rev-parse", "refs/heads/umut/feature"), fx.divergent);
	});

	// Regression for Defect 2 (#2143 follow-up): a `git fetch` updates refs/remotes/origin/* +
	// FETCH_HEAD, NOT refs/heads/main — the guard MUST allow it. The CI breaker was leak-guard's
	// `git fetch --depth=1 origin main` aborting; this proves the fetch's ref-transaction passes.
	it("ALLOWS a real `git fetch origin main` (updates refs/remotes/origin/main + FETCH_HEAD, not refs/heads/main)", () => {
		// advance origin so the fetch actually transacts a remote-tracking update
		const originClone = join(fx.dir, "..", "origin-advance");
		execFileSync("git", ["clone", "-q", join(fx.dir, "..", "origin.git"), originClone]);
		git(originClone, "config", "user.email", "t@t");
		git(originClone, "config", "user.name", "t");
		const advanced = commitEmpty(originClone, "origin-advance-2");
		execFileSync("git", ["push", "-q", "origin", "main"], {cwd: originClone});

		installHook(fx.dir);
		let ok = true;
		try {
			execFileSync("git", ["fetch", "--no-tags", "origin", "main"], {cwd: fx.dir, stdio: "pipe"});
		} catch {
			ok = false;
		}
		rmSync(join(fx.dir, ".git", "hooks", "reference-transaction"), {force: true});
		rmSync(originClone, {recursive: true, force: true});
		assert.isTrue(
			ok,
			"a `git fetch origin main` must not be aborted — it never touches refs/heads/main",
		);
		assert.strictEqual(
			git(fx.dir, "rev-parse", "refs/remotes/origin/main"),
			advanced,
			"the remote-tracking ref must have advanced (the fetch's ref-transaction was allowed)",
		);
	});

	// Regression for Defect 1 (#1050/#787 fail-open): when the CLI can't RUN (missing bin /
	// node module), the hook must FAIL OPEN — allow the ref-move, never abort. Only a positive
	// refuse (exit 3) aborts. We point the hook at a non-existent bin to simulate the
	// not-yet-installed / stripped-PATH env, then attempt the very divergence that would abort
	// if the guard were live — and assert it is ALLOWED (the guard couldn't run ⇒ fail-open).
	it("FAILS OPEN (allows) when the CLI is unavailable — a missing bin never aborts a ref transaction", () => {
		const missingBin = join(fx.dir, "does-not-exist", "bin.ts");
		installHook(fx.dir, guardCmd(missingBin));
		git(fx.dir, "update-ref", "refs/heads/main", fx.base); // ensure a known start
		let ok = true;
		try {
			// This is a DIVERGENCE that a live guard would abort — but the CLI can't run, so fail-open.
			execFileSync("git", ["update-ref", "refs/heads/main", fx.divergent], {
				cwd: fx.dir,
				stdio: "pipe",
			});
		} catch {
			ok = false;
		}
		rmSync(join(fx.dir, ".git", "hooks", "reference-transaction"), {force: true});
		const landed = git(fx.dir, "rev-parse", "refs/heads/main");
		git(fx.dir, "update-ref", "refs/heads/main", fx.base); // restore fixture
		assert.isTrue(
			ok,
			"a missing-CLI hook must fail OPEN (allow), never abort the transaction (#1050/#787)",
		);
		assert.strictEqual(
			landed,
			fx.divergent,
			"the move was allowed because the guard could not run",
		);
	});

	// #2270 mechanical half (criteria 1/2/4): the SAME installed reference-transaction hook that
	// catches a diverging refs/heads/main move must also refuse a bare HEAD-DETACHING checkout on
	// the shared PRIMARY checkout — the operation that strands the human's shared HEAD off its
	// branch when a worktree-isolated agent's cwd resets to the primary between Bash calls. These
	// drive a REAL `git checkout` (not a synthetic update-ref) so the assertion is grounded in
	// git's actual reference-transaction behavior for a detach: HEAD → a concrete commit, no
	// paired refs/heads/* move.
	const headRef = (repoDir: string): string =>
		execFileSync("git", ["symbolic-ref", "-q", "HEAD"], {cwd: repoDir, encoding: "utf8"}).trim();

	it("aborts a bare `git checkout <sha>` HEAD-detach on the PRIMARY — HEAD stays attached to its branch", () => {
		git(fx.dir, "checkout", "-q", "main"); // known attached start
		const before = headRef(fx.dir);
		installHook(fx.dir);
		let aborted = false;
		try {
			execFileSync("git", ["checkout", fx.divergent], {cwd: fx.dir, stdio: "pipe"});
		} catch {
			aborted = true; // git exits non-zero: "ref updates aborted by hook"
		}
		rmSync(join(fx.dir, ".git", "hooks", "reference-transaction"), {force: true});
		assert.isTrue(aborted, "the bare HEAD-detach on the primary should be aborted by the hook");
		assert.strictEqual(
			headRef(fx.dir),
			before,
			"HEAD must still be attached to its branch (the detach was refused)",
		);
	});

	it("does NOT abort an attached commit on a feature branch on the PRIMARY (HEAD paired with its branch move)", () => {
		// A feature branch, not main, so the pre-existing #2143 main-divergence guard is out of the
		// picture — this isolates the HEAD-detach guard's pairing rule (HEAD moved WITH its branch).
		git(fx.dir, "checkout", "-q", "-b", "attached-feature", fx.base);
		installHook(fx.dir);
		let ok = true;
		try {
			execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "attached"], {
				cwd: fx.dir,
				stdio: "pipe",
			});
		} catch {
			ok = false;
		}
		rmSync(join(fx.dir, ".git", "hooks", "reference-transaction"), {force: true});
		const stayed = headRef(fx.dir);
		git(fx.dir, "checkout", "-q", "main"); // restore fixture: reattach main, drop the feature branch
		git(fx.dir, "branch", "-qD", "attached-feature");
		assert.isTrue(ok, "an attached commit (paired HEAD+branch move) must not be aborted");
		assert.strictEqual(
			stayed,
			"refs/heads/attached-feature",
			"HEAD stays attached to the feature branch after the commit",
		);
	});

	// The load-bearing PULLER flow (#2415): git ≥ 2.45 (CI/prod 2.55) queues this reattach as a HEAD
	// update whose new value is the SYMREF `ref:refs/heads/main` (git 2.40 queues no HEAD line at all).
	// Either way it is an ATTACH, never a detach — the guard must allow it on both versions.
	it("does NOT abort a `git checkout main` reattach on the PRIMARY (HEAD → symref, git ≥ 2.45; no HEAD line, git 2.40)", () => {
		git(fx.dir, "checkout", "-q", "--detach", fx.base); // detach BEFORE the hook is installed
		installHook(fx.dir);
		let ok = true;
		try {
			execFileSync("git", ["checkout", "main"], {cwd: fx.dir, stdio: "pipe"});
		} catch {
			ok = false;
		}
		rmSync(join(fx.dir, ".git", "hooks", "reference-transaction"), {force: true});
		assert.isTrue(ok, "the PULLER `checkout main` reattach must not be aborted");
		assert.strictEqual(headRef(fx.dir), "refs/heads/main", "HEAD is reattached to main");
	});

	it("does NOT abort a bare HEAD-detach inside a LINKED worktree (only the shared primary is guarded)", () => {
		const wt = join(fx.dir, "..", "wt-head-detach");
		execFileSync("git", ["worktree", "add", "-q", "--detach", wt, fx.base], {cwd: fx.dir});
		installHook(fx.dir); // shared hook (common .git) — but the worktree's HEAD is not the primary's
		let ok = true;
		try {
			execFileSync("git", ["checkout", fx.divergent], {cwd: wt, stdio: "pipe"});
		} catch {
			ok = false;
		}
		rmSync(join(fx.dir, ".git", "hooks", "reference-transaction"), {force: true});
		execFileSync("git", ["worktree", "remove", "--force", wt], {cwd: fx.dir});
		assert.isTrue(
			ok,
			"a worktree agent detaching its OWN HEAD must not be blocked (no false-positive on coders)",
		);
	});
});
