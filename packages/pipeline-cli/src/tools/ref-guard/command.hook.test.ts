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

describe("ref-guard reference-transaction — real git facts", () => {
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
describe("ref-guard — installed reference-transaction hook fires on a BARE git ref-move (no pipeline command)", () => {
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
});
