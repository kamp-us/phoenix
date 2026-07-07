/**
 * End-to-end guard for the SessionStart cadence (#2238): the wiring runs
 * `pipeline-cli worktree-sweep --execute`, so this drives that exact command
 * against a REAL git repo and asserts the safe-prune invariant holds through the
 * command boundary — a clean, merged, IDLE, unlocked worktree is removed WITHOUT
 * `--force`, while a dirty (unpushed), a recently-active, or a locked worktree is
 * KEPT (the #2240 liveness guard — a live sibling lane must never be swept). The
 * pure classifier is unit-tested in `worktree-sweep.unit.test.ts`; this proves the
 * executable the cadence invokes honors that classification.
 *
 * The tmp repo's `origin` is a local path, not github.com, so the network open-PR
 * signal is N/A here and the mtime-idle + locked guards carry liveness (the open-PR
 * KEEP is proven at the pure-classifier level). Idleness is simulated by backdating
 * the worktree dir + its per-tree `HEAD`/`logs/HEAD` mtimes past the 30-min threshold.
 */
import {execFile, execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

// Run `pipeline-cli worktree-sweep [--execute]` with the process cwd inside `mainRepo`
// (the sweep enumerates the current repo's worktrees), exactly as the SessionStart hook does.
const runSweep = (cwd: string, flags: ReadonlyArray<string>): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile("node", [BIN, "worktree-sweep", ...flags], {cwd}, (error, stdout, stderr) => {
			const code =
				error && typeof (error as {code?: unknown}).code === "number"
					? (error as {code: number}).code
					: 0;
			resolve({code, stdout, stderr});
		});
	});

describe("worktree-sweep --execute — SessionStart cadence against a REAL git repo (#2238/#2240)", () => {
	let mainRepo: string;
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"});

	// Push a managed worktree's dir + per-tree HEAD/logs mtimes ~2h into the past so it reads
	// idle (well past the 30-min threshold) — simulating an orphaned tree a live lane would not be.
	const backdate = (wtPath: string) => {
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		const gitdir = git(mainRepo, "-C", wtPath, "rev-parse", "--absolute-git-dir").trim();
		for (const p of [wtPath, join(gitdir, "HEAD"), join(gitdir, "logs", "HEAD")]) {
			if (existsSync(p)) utimesSync(p, old, old);
		}
	};

	beforeAll(() => {
		mainRepo = mkdtempSync(join(tmpdir(), "wts-main-"));
		git(mainRepo, "init", "-q", "-b", "main");
		git(mainRepo, "config", "user.email", "t@t.t");
		git(mainRepo, "config", "user.name", "t");
		writeFileSync(join(mainRepo, "README.md"), "x");
		git(mainRepo, "add", ".");
		git(mainRepo, "commit", "-q", "-m", "init");
		// `origin/main` is the reachability oracle the classifier consults — point it at self.
		git(mainRepo, "remote", "add", "origin", mainRepo);
		git(mainRepo, "fetch", "-q", "origin");
	});

	afterAll(() => {
		rmSync(mainRepo, {recursive: true, force: true});
	});

	it("removes a CLEAN + IDLE + unlocked orphan, but KEEPS dirty / recently-active / locked (never --force)", async () => {
		// Clean + reachable + IDLE (backdated) + unlocked → the only genuinely-orphaned tree → removed.
		const orphanWt = join(mainRepo, ".claude", "worktrees", "wf_orphan");
		git(mainRepo, "worktree", "add", "-q", "--detach", orphanWt, "HEAD");
		backdate(orphanWt);

		// Clean + reachable but RECENTLY-ACTIVE (fresh mtime, not backdated) → live lane → KEPT.
		const liveWt = join(mainRepo, ".claude", "worktrees", "wf_live");
		git(mainRepo, "worktree", "add", "-q", "--detach", liveWt, "HEAD");

		// Clean + reachable + idle but LOCKED → pinned in-use → KEPT.
		const lockedWt = join(mainRepo, ".claude", "worktrees", "wf_locked");
		git(mainRepo, "worktree", "add", "-q", "--detach", lockedWt, "HEAD");
		git(mainRepo, "worktree", "lock", lockedWt);
		backdate(lockedWt);

		// Dirty → must be KEPT with its unpushed file intact (proves no --force).
		const dirtyWt = join(mainRepo, ".claude", "worktrees", "wf_dirty");
		git(mainRepo, "worktree", "add", "-q", "--detach", dirtyWt, "HEAD");
		writeFileSync(join(dirtyWt, "uncommitted.txt"), "unpushed work");
		backdate(dirtyWt);

		const {stdout, code} = await runSweep(mainRepo, ["--execute"]);
		assert.strictEqual(code, 0, stdout);
		assert.isFalse(existsSync(orphanWt), "clean+idle+unlocked orphan must be removed");
		assert.isTrue(existsSync(liveWt), "recently-active worktree must be kept (live sibling lane)");
		assert.isTrue(existsSync(lockedWt), "locked worktree must be kept");
		assert.isTrue(existsSync(dirtyWt), "dirty worktree must be kept");
		assert.isTrue(
			existsSync(join(dirtyWt, "uncommitted.txt")),
			"unpushed file must survive — the classifier KEEPS dirty, and remove runs without --force",
		);

		// unlock so afterAll's rmSync can tear the tree down cleanly.
		git(mainRepo, "worktree", "unlock", lockedWt);
	}, 30_000);

	it("dry-run (no --execute) touches nothing — even a clean+idle+unlocked orphan", async () => {
		const keepWt = join(mainRepo, ".claude", "worktrees", "wf_dryrun");
		git(mainRepo, "worktree", "add", "-q", "--detach", keepWt, "HEAD");
		backdate(keepWt);
		const {code} = await runSweep(mainRepo, []);
		assert.strictEqual(code, 0);
		assert.isTrue(existsSync(keepWt), "dry-run must never remove a worktree");
	}, 30_000);
});
