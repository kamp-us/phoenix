/**
 * End-to-end guard for the SessionStart cadence (#2238): the wiring runs
 * `pipeline-cli worktree-sweep --execute`, so this drives that exact command
 * against a REAL git repo and asserts the safe-prune invariant holds through the
 * command boundary — a clean, merged worktree is removed WITHOUT `--force`, and a
 * dirty (unpushed) worktree is KEPT. The pure classifier is unit-tested in
 * `worktree-sweep.unit.test.ts`; this proves the executable the cadence invokes
 * honors that classification and never force-discards work.
 */
import {execFile, execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
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

describe("worktree-sweep --execute — SessionStart cadence against a REAL git repo (#2238)", () => {
	let mainRepo: string;
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"});

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

	it("removes a CLEAN worktree reachable from origin/main, and KEEPS a DIRTY one (never --force)", async () => {
		// Clean + reachable (detached at a commit already on origin/main) → removable.
		const cleanWt = join(mainRepo, ".claude", "worktrees", "wf_clean");
		git(mainRepo, "worktree", "add", "-q", "--detach", cleanWt, "HEAD");
		// Dirty → must be KEPT with its unpushed file intact.
		const dirtyWt = join(mainRepo, ".claude", "worktrees", "wf_dirty");
		git(mainRepo, "worktree", "add", "-q", "--detach", dirtyWt, "HEAD");
		writeFileSync(join(dirtyWt, "uncommitted.txt"), "unpushed work");

		const {stdout, code} = await runSweep(mainRepo, ["--execute"]);
		assert.strictEqual(code, 0, stdout);
		assert.isFalse(existsSync(cleanWt), "clean+merged worktree must be removed");
		assert.isTrue(existsSync(dirtyWt), "dirty worktree must be kept");
		assert.isTrue(
			existsSync(join(dirtyWt, "uncommitted.txt")),
			"unpushed file must survive — the classifier KEEPS dirty, and remove runs without --force",
		);
	}, 30_000);

	it("dry-run (no --execute) touches nothing — the default cadence-free behavior stays safe", async () => {
		const keepWt = join(mainRepo, ".claude", "worktrees", "wf_dryrun");
		git(mainRepo, "worktree", "add", "-q", "--detach", keepWt, "HEAD");
		const {code} = await runSweep(mainRepo, []);
		assert.strictEqual(code, 0);
		assert.isTrue(existsSync(keepWt), "dry-run must never remove a worktree");
	}, 30_000);
});
