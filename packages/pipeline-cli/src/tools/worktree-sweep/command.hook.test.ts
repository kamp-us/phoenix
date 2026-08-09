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
import {existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../../test-budget.ts";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

// Run `pipeline-cli worktree-sweep [--execute]` with the process cwd inside `mainRepo`
// (the sweep enumerates the current repo's worktrees), exactly as the SessionStart hook does.
// `env` overlays the inherited environment — the tests point `$CLAUDE_CONFIG_DIR` at a synthetic
// session registry so owner presence (#3943) is a fact the test controls, not the live machine's.
const runSweep = (
	cwd: string,
	flags: ReadonlyArray<string>,
	env: Record<string, string> = {},
): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile(
			"node",
			[BIN, "worktree-sweep", ...flags],
			{cwd, env: {...process.env, ...env}},
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as {code?: unknown}).code === "number"
						? (error as {code: number}).code
						: 0;
				resolve({code, stdout, stderr});
			},
		);
	});

/** A session id the synthetic registry records as RUNNING, and one it does not (⇒ provably dead). */
const LIVE_SID = "11111111-1111-4111-8111-111111111111";
const DEAD_SID = "22222222-2222-4222-8222-222222222222";

describe("worktree-sweep --execute — SessionStart cadence against a REAL git repo (#2238/#2240)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	let mainRepo: string;
	/** A `$CLAUDE_CONFIG_DIR` holding a `sessions/` registry with exactly one live entry (#3943). */
	let configDir: string;
	let sweepEnv: Record<string, string>;
	// $TMPDIR-shaped roots for review-head trees (removed in afterAll — any the sweep KEEPS must be cleaned).
	const reviewRoots: Array<string> = [];
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"});

	/**
	 * Stamp an owning session into a worktree's git admin dir, as `create-worktree.sh` does. The
	 * kind defaults to `launcher` because that is what the hook writes and what a legacy stamp
	 * means (#4001); pass `occupant` only for the case that models a stamp naming the holder itself.
	 */
	const stampOwner = (wtPath: string, sessionId: string, kind = "launcher") => {
		const gitdir = git(mainRepo, "-C", wtPath, "rev-parse", "--absolute-git-dir").trim();
		writeFileSync(join(gitdir, "kampus-owner.json"), JSON.stringify({sessionId, ownerKind: kind}));
	};

	// Push a managed worktree's dir + per-tree HEAD/logs mtimes into the past. 1h reads IDLE (well
	// past the 30-min threshold) while staying INSIDE the 2h launcher grace window; 3h is past both,
	// which is what makes a launcher-owned orphan sweep-eligible (#4001).
	const backdateBy = (wtPath: string, ms: number) => {
		const old = new Date(Date.now() - ms);
		const gitdir = git(mainRepo, "-C", wtPath, "rev-parse", "--absolute-git-dir").trim();
		for (const p of [wtPath, join(gitdir, "HEAD"), join(gitdir, "logs", "HEAD")]) {
			if (existsSync(p)) utimesSync(p, old, old);
		}
	};
	const backdate = (wtPath: string) => backdateBy(wtPath, 60 * 60 * 1000);
	const backdateBeyondGrace = (wtPath: string) => backdateBy(wtPath, 3 * 60 * 60 * 1000);

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

		// The presence oracle, made deterministic: one registry entry for LIVE_SID carrying THIS
		// test process's pid (trivially running), so the sweep's registry-trust gate resolves and
		// any other stamped session is provably not running.
		configDir = mkdtempSync(join(tmpdir(), "wts-cfg-"));
		mkdirSync(join(configDir, "sessions"));
		writeFileSync(
			join(configDir, "sessions", `${process.pid}.json`),
			JSON.stringify({pid: process.pid, sessionId: LIVE_SID}),
		);
		sweepEnv = {CLAUDE_CONFIG_DIR: configDir};
	});

	afterAll(() => {
		rmSync(mainRepo, {recursive: true, force: true});
		rmSync(configDir, {recursive: true, force: true});
		for (const r of reviewRoots) rmSync(r, {recursive: true, force: true});
	});

	it("removes a CLEAN + IDLE + unlocked orphan, but KEEPS dirty / recently-active / locked (never --force)", async () => {
		// Clean + reachable + IDLE (backdated) + unlocked → the only genuinely-orphaned tree → removed.
		const orphanWt = join(mainRepo, ".claude", "worktrees", "wf_orphan");
		git(mainRepo, "worktree", "add", "-q", "--detach", orphanWt, "HEAD");
		stampOwner(orphanWt, DEAD_SID);
		backdate(orphanWt);

		// Clean + reachable but RECENTLY-ACTIVE (fresh mtime, not backdated) → live lane → KEPT.
		const liveWt = join(mainRepo, ".claude", "worktrees", "wf_live");
		git(mainRepo, "worktree", "add", "-q", "--detach", liveWt, "HEAD");
		stampOwner(liveWt, DEAD_SID);

		// Clean + reachable + idle but LOCKED → pinned in-use → KEPT.
		const lockedWt = join(mainRepo, ".claude", "worktrees", "wf_locked");
		git(mainRepo, "worktree", "add", "-q", "--detach", lockedWt, "HEAD");
		git(mainRepo, "worktree", "lock", lockedWt);
		stampOwner(lockedWt, DEAD_SID);
		backdate(lockedWt);

		// Dirty → must be KEPT with its unpushed file intact (proves no --force).
		const dirtyWt = join(mainRepo, ".claude", "worktrees", "wf_dirty");
		git(mainRepo, "worktree", "add", "-q", "--detach", dirtyWt, "HEAD");
		writeFileSync(join(dirtyWt, "uncommitted.txt"), "unpushed work");
		stampOwner(dirtyWt, DEAD_SID);
		backdate(dirtyWt);

		const {stdout, code} = await runSweep(mainRepo, ["--execute"], sweepEnv);
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
	});

	it("reclaims a leaked review-head detached checkout but KEEPS a dirty one (never --force) — #2785", async () => {
		// The review gates root these under $TMPDIR (outside .claude/worktrees), so mirror that:
		// a separate temp root, leaf `review-head-<PR>`, which `isReviewHeadWorktree` keys on.
		const reviewRoot = mkdtempSync(join(tmpdir(), "wts-rev-"));
		reviewRoots.push(reviewRoot);

		// Clean + idle + unlocked leaked review head → reclaimed (no merge gate for this class).
		const leakedReviewWt = join(reviewRoot, "review-head-8001");
		git(mainRepo, "worktree", "add", "-q", "--detach", leakedReviewWt, "HEAD");
		stampOwner(leakedReviewWt, DEAD_SID);
		backdate(leakedReviewWt);

		// Dirty review head → KEPT, its scratch file intact (proves the reclaim never --force-nukes).
		const dirtyReviewWt = join(reviewRoot, "review-doc-head-8002");
		git(mainRepo, "worktree", "add", "-q", "--detach", dirtyReviewWt, "HEAD");
		writeFileSync(join(dirtyReviewWt, "scratch.txt"), "mid-review edit");
		stampOwner(dirtyReviewWt, DEAD_SID);
		backdate(dirtyReviewWt);

		const {stdout, code} = await runSweep(mainRepo, ["--execute"], sweepEnv);
		assert.strictEqual(code, 0, stdout);
		assert.isFalse(existsSync(leakedReviewWt), "clean+idle leaked review-head must be reclaimed");
		assert.isTrue(existsSync(dirtyReviewWt), "dirty review-head must be kept (no --force)");
		assert.isTrue(
			existsSync(join(dirtyReviewWt, "scratch.txt")),
			"the dirty review-head's scratch file must survive — remove runs without --force",
		);
	});

	it("reads a review-head tree's OWN pid-bearing lock as presence: live pid KEPT, dead pid reclaimed — #4004", async () => {
		const reviewRoot = mkdtempSync(join(tmpdir(), "wts-lock-"));
		reviewRoots.push(reviewRoot);
		const lockReason = (pid: number) => `claude agent review-head-x (pid ${pid} start now)`;
		// A pid that is provably GONE: the shell prints its own pid and exits before the sweep runs.
		const deadPid = Number.parseInt(execFileSync("sh", ["-c", "echo $$"], {encoding: "utf8"}), 10);

		// Locked with THIS process's pid — a live reviewer. Otherwise fully reclaimable (clean, idle,
		// no stamp), so only the lock's presence signal can save it.
		const liveWt = join(reviewRoot, "review-head-9001");
		git(
			mainRepo,
			"worktree",
			"add",
			"-q",
			"--detach",
			"--lock",
			"--reason",
			lockReason(process.pid),
			liveWt,
			"HEAD",
		);
		backdate(liveWt);

		// Same shape, locked with a dead pid — a stale pin, so the lock must not keep it forever.
		const orphanWt = join(reviewRoot, "review-head-9002");
		git(
			mainRepo,
			"worktree",
			"add",
			"-q",
			"--detach",
			"--lock",
			"--reason",
			lockReason(deadPid),
			orphanWt,
			"HEAD",
		);
		backdate(orphanWt);

		const {stdout, code} = await runSweep(mainRepo, ["--execute"], sweepEnv);
		assert.strictEqual(code, 0, stdout);
		assert.isTrue(existsSync(liveWt), "a live reviewer's locked tree must be KEPT");
		assert.isFalse(
			existsSync(orphanWt),
			"a stale-locked orphan must be reclaimed, not pinned forever",
		);

		git(mainRepo, "worktree", "unlock", liveWt);
	});

	it("prunes a torn-down review tree's LOCKED metadata — plain `git worktree prune` skips it — #4004", async () => {
		const reviewRoot = mkdtempSync(join(tmpdir(), "wts-gone-"));
		reviewRoots.push(reviewRoot);
		const goneWt = join(reviewRoot, "review-head-9003");
		git(
			mainRepo,
			"worktree",
			"add",
			"-q",
			"--detach",
			"--lock",
			"--reason",
			"claude agent review-head-x (pid 4242 start now)",
			goneWt,
			"HEAD",
		);
		// Exactly what the review gates' teardown does: `rm -rf "$REVIEW_WT" && git worktree prune`.
		rmSync(goneWt, {recursive: true, force: true});
		git(mainRepo, "worktree", "prune");
		assert.isTrue(
			git(mainRepo, "worktree", "list", "--porcelain").includes(goneWt),
			"precondition: git's own prune leaves a LOCKED gone-dir entry behind",
		);

		const {stdout, code} = await runSweep(mainRepo, ["--execute"], sweepEnv);
		assert.strictEqual(code, 0, stdout);
		assert.isFalse(
			git(mainRepo, "worktree", "list", "--porcelain").includes(goneWt),
			"the sweep must unlock the stale crew-agent lock and prune the metadata",
		);
	});

	it("dry-run (no --execute) touches nothing — even a clean+idle+unlocked orphan", async () => {
		const keepWt = join(mainRepo, ".claude", "worktrees", "wf_dryrun");
		git(mainRepo, "worktree", "add", "-q", "--detach", keepWt, "HEAD");
		stampOwner(keepWt, DEAD_SID);
		backdate(keepWt);
		const {code} = await runSweep(mainRepo, [], sweepEnv);
		assert.strictEqual(code, 0);
		assert.isTrue(existsSync(keepWt), "dry-run must never remove a worktree");
	});

	// The #3943 regression, end to end: the shipper-shaped state that got two LIVE worktrees removed
	// — clean, content-merged, unlocked, and mtime-idle — must survive purely because its owning
	// session is registered as running. The unstamped sibling pins the other half: an owner we cannot
	// prove dead is KEPT, so a fix that reads "unprovable" as "orphan" turns this red.
	it("KEEPS an occupant-owned tree AND an unstamped tree in the exact clean+merged+idle state that is otherwise reaped (#3943)", async () => {
		const liveOwnedWt = join(mainRepo, ".claude", "worktrees", "wf_live_session");
		git(mainRepo, "worktree", "add", "-q", "--detach", liveOwnedWt, "HEAD");
		stampOwner(liveOwnedWt, LIVE_SID, "occupant");
		backdate(liveOwnedWt);

		const unstampedWt = join(mainRepo, ".claude", "worktrees", "wf_unstamped");
		git(mainRepo, "worktree", "add", "-q", "--detach", unstampedWt, "HEAD");
		backdate(unstampedWt);

		// A dead-owner control in the identical state — proves the KEEPs above come from presence,
		// not from the sweep having gone inert.
		const deadOwnedWt = join(mainRepo, ".claude", "worktrees", "wf_dead_session");
		git(mainRepo, "worktree", "add", "-q", "--detach", deadOwnedWt, "HEAD");
		stampOwner(deadOwnedWt, DEAD_SID);
		backdate(deadOwnedWt);

		const {stdout, code} = await runSweep(mainRepo, ["--execute"], sweepEnv);
		assert.strictEqual(code, 0, stdout);
		assert.isTrue(existsSync(liveOwnedWt), "a LIVE session's worktree must never be removed");
		assert.isTrue(existsSync(unstampedWt), "an owner we cannot prove dead must be KEPT");
		assert.isFalse(existsSync(deadOwnedWt), "the dead-owner control must still be reclaimed");
		assert.include(stdout, "live-session");
		assert.include(stdout, "owner-unknown");
	});

	// The #4001 regression, end to end: LIVE_SID stands in for a crew pane that is STILL RUNNING and
	// has spawned many trees. A tree it launched, whose occupant finished long ago, must become
	// reclaimable on its own idle clock — the pane never exits, so waiting for it is waiting forever.
	it("reclaims a LAUNCHER-owned orphan while its launcher is still registered as running (#4001)", async () => {
		const staleWt = join(mainRepo, ".claude", "worktrees", "wf_launcher_stale");
		git(mainRepo, "worktree", "add", "-q", "--detach", staleWt, "HEAD");
		stampOwner(staleWt, LIVE_SID);
		backdateBeyondGrace(staleWt);

		// Same live launcher, same stamp — but touched recently enough to sit inside the grace
		// window. It pins the fail-closed direction: the launcher branch reclaims on IDLE, and only
		// past the window, so a tree whose occupant may still hold it is never pulled out from under.
		const freshWt = join(mainRepo, ".claude", "worktrees", "wf_launcher_fresh");
		git(mainRepo, "worktree", "add", "-q", "--detach", freshWt, "HEAD");
		stampOwner(freshWt, LIVE_SID);
		backdate(freshWt);

		const {stdout, code} = await runSweep(mainRepo, ["--execute"], sweepEnv);
		assert.strictEqual(code, 0, stdout);
		assert.isFalse(
			existsSync(staleWt),
			"a long-idle tree launched by a still-running pane must be reclaimed, not held for the pane's lifetime",
		);
		assert.isTrue(existsSync(freshWt), "inside the grace window the launcher-owned tree is KEPT");
		// The near-silence was as much a diagnosability failure as a reaping one: the reason a tree
		// was kept must name the launcher branch, not read as ordinary presence.
		assert.include(stdout, "launcher-alive");

		git(mainRepo, "worktree", "remove", freshWt);
	});

	// The fail-closed half of the presence gate: with no readable registry there is no way to prove
	// any owner dead, so the sweep must remove NOTHING — not fall back to the age signal.
	it("removes nothing when the session registry is unreadable — fail-closed, not age-based (#3943)", async () => {
		const wt = join(mainRepo, ".claude", "worktrees", "wf_no_registry");
		git(mainRepo, "worktree", "add", "-q", "--detach", wt, "HEAD");
		stampOwner(wt, DEAD_SID);
		backdate(wt);

		const emptyConfig = mkdtempSync(join(tmpdir(), "wts-cfg-none-"));
		const {stdout, code} = await runSweep(mainRepo, ["--execute"], {
			CLAUDE_CONFIG_DIR: emptyConfig,
		});
		rmSync(emptyConfig, {recursive: true, force: true});
		assert.strictEqual(code, 0, stdout);
		assert.isTrue(existsSync(wt), "with no trustworthy registry, nothing may be removed");
		assert.include(stdout, "registry UNRESOLVED");

		git(mainRepo, "worktree", "remove", wt);
	});

	// #3654: a tree whose working dir was cleaned out from under it (a dead session's temp root)
	// leaves stale `.git/worktrees/<id>` metadata that `git worktree list` keeps surfacing. The
	// sweep must prune it via `git worktree prune` (no `git worktree remove` — the path is gone),
	// and leave a genuinely-present unmerged tree untouched.
	// Match on the repo-relative tail: macOS git reports the realpath (`/private/var/…`) while
	// `mainRepo` is the `/var/…` symlink alias, so only an endsWith on the sub-path is stable.
	const listsPath = (p: string): boolean => {
		const tail = p.slice(mainRepo.length);
		return git(mainRepo, "worktree", "list", "--porcelain")
			.split("\n")
			.some((l) => l.startsWith("worktree ") && l.slice("worktree ".length).endsWith(tail));
	};

	it("prunes a gone-dir tree's stale metadata on --execute, but keeps a present unmerged tree", async () => {
		const goneWt = join(mainRepo, ".claude", "worktrees", "wf_gone");
		git(mainRepo, "worktree", "add", "-q", "--detach", goneWt, "HEAD");
		// Remove the working dir out from under git — now only the admin metadata lingers (prunable).
		rmSync(goneWt, {recursive: true, force: true});
		assert.isTrue(
			listsPath(goneWt),
			"precondition: git still lists the gone tree's stale metadata",
		);

		// A present, clean, but genuinely UNMERGED tree — a commit past origin/main so its tip is
		// neither ancestor-reachable nor content-equivalent — must survive (never reaped).
		const liveWt = join(mainRepo, ".claude", "worktrees", "wf_gone_live");
		git(mainRepo, "worktree", "add", "-q", "-b", "umut/unmerged-3654", liveWt, "HEAD");
		writeFileSync(join(liveWt, "feature.txt"), "unmerged feature work");
		git(liveWt, "add", ".");
		git(liveWt, "commit", "-q", "-m", "unmerged feature");
		backdate(liveWt);

		const {stdout, code} = await runSweep(mainRepo, ["--execute"], sweepEnv);
		assert.strictEqual(code, 0, stdout);
		assert.isFalse(listsPath(goneWt), "gone-dir metadata must be pruned from git's worktree list");
		assert.isTrue(existsSync(liveWt), "a present unmerged tree must be kept");
		assert.isTrue(listsPath(liveWt), "the present unmerged tree stays registered");

		git(mainRepo, "worktree", "remove", "--force", liveWt);
	});

	it("dry-run leaves gone-dir metadata in place (nothing pruned without --execute)", async () => {
		const goneWt = join(mainRepo, ".claude", "worktrees", "wf_gone_dry");
		git(mainRepo, "worktree", "add", "-q", "--detach", goneWt, "HEAD");
		rmSync(goneWt, {recursive: true, force: true});
		const {code} = await runSweep(mainRepo, [], sweepEnv);
		assert.strictEqual(code, 0);
		assert.isTrue(listsPath(goneWt), "dry-run must not prune gone-dir metadata");
		git(mainRepo, "worktree", "prune"); // clean up the fixture's stale metadata
	});
});
