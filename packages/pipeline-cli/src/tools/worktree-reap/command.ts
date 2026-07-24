/**
 * The `worktree-reap` tool — `pipeline-cli worktree-reap [--execute]`.
 *
 * A safe reaper for agent worktrees orphaned by DEAD crew sessions (issue #3754). Dead
 * sessions leave their `isolation:worktree` trees (and checked-out branches) behind under
 * `.claude/worktrees/`, where they accumulate and block their branches from being
 * re-checked-out elsewhere. This verb identifies trees whose owning SESSION is provably
 * dead, and reclaims only the ones that hold nothing recoverable.
 *
 * Eligibility is session-presence-based, never age-based (ADR 0191). The presence signal
 * is the owning process the harness stamps into each agent worktree's git lock reason —
 * `claude agent <id> (pid <N> start <date>)` (surfaced by `git worktree list --porcelain`
 * as the `locked <reason>` line). That pid is the top-level crew session process; a worktree
 * is orphan-eligible ONLY when its pid is provably not running (`process.kill(pid, 0)` →
 * ESRCH). This is the deliberate contrast with the age-based `worktree-sweep` (mtime-idle,
 * #2240): a genuinely idle-but-live session is spared here because its process still resolves.
 *
 * Safe by construction (enforcement lines):
 *   1. The pure classifier (`worktree-reap.ts`) marks a worktree reapable ONLY when its
 *      session is dead AND the tree is clean (no uncommitted changes) AND all its commits
 *      have landed on `origin/main` (no unpushed work). A dirty / unpushed / live tree is
 *      KEPT and named in the report, never destroyed. Every fact fails safe toward KEEP.
 *   2. Reclaim is `git worktree unlock` (justified — the session is proven dead, so the
 *      pid-lock is stale) followed by `git worktree remove` WITHOUT `--force`. Git itself
 *      refuses a tree it judges unsafe (dirty/current) even after unlock, and that refusal
 *      is caught and reported as KEPT, never escalated to `--force`. The unlock is scoped to
 *      trees the classifier already proved dead+clean, so it never frees a live lane's lock.
 *
 * DRY-RUN by default: with no flag it prints what it WOULD reap / keep-dirty / spare and
 * exits 0 without touching anything. The git IO uses `execFileSync` directly (mirrors
 * `worktree-sweep`), so the tool's requirement stays at the Node platform ceiling the
 * registry provides.
 */
import {execFileSync} from "node:child_process";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {
	computeWorktreeReapPlan,
	isManagedAgentWorktree,
	parseAgentLockOwner,
	parseWorktreeList,
	type ReapCandidate,
} from "./worktree-reap.ts";

interface GitResult {
	readonly ok: boolean;
	readonly stdout: string;
	readonly stderr: string;
}

const runGit = (args: ReadonlyArray<string>): GitResult => {
	// biome-ignore lint/plugin: best-effort git shell — a non-zero exit is fully absorbed into a {ok:false} GitResult the caller branches on, never the E channel; a total helper, not Effect-cosplay.
	try {
		const stdout = execFileSync("git", [...args], {encoding: "utf8"});
		return {ok: true, stdout, stderr: ""};
	} catch (cause) {
		const e = cause as {stdout?: Buffer | string; stderr?: Buffer | string};
		return {ok: false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "")};
	}
};

/**
 * Is the owning session's process still running (ADR 0191 presence)? `process.kill(pid, 0)`
 * sends no signal — it only probes existence: it returns cleanly when the pid resolves, throws
 * `ESRCH` when it does not, and throws `EPERM` when the pid exists but is owned by another user.
 * Only `ESRCH` proves the session dead; every other outcome (alive, EPERM, or an unexpected
 * error) fails safe toward ALIVE → the worktree is SPARED. A reused pid therefore also reads
 * alive — erring toward keeping a tree, never toward reaping a live one.
 */
const pidAlive = (pid: number): boolean => {
	// biome-ignore lint/plugin: best-effort existence probe — `process.kill(pid, 0)` signals nothing and throws only to report absence (ESRCH); the throw is absorbed into a plain boolean the caller branches on, never the E channel. A total helper, not Effect-cosplay.
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return (cause as {code?: string}).code !== "ESRCH";
	}
};

/** `git status --porcelain` non-empty ⇒ uncommitted. Indeterminate (command failed) ⇒ uncommitted (fail-safe KEEP). */
const worktreeHasUncommitted = (path: string): boolean => {
	const r = runGit(["-C", path, "status", "--porcelain"]);
	if (!r.ok) return true;
	return r.stdout.trim() !== "";
};

/**
 * Is `head` reachable from `origin/main`? `git merge-base --is-ancestor` exits 0 when it is,
 * 1 when not, and non-zero (128) when a ref can't be resolved — all non-zero cases collapse to
 * "not reachable", which reads as unpushed (KEEP). So a missing `origin/main` fails safe.
 */
const reachableFromOriginMain = (head: string | null): boolean => {
	if (head === null) return false;
	return runGit(["merge-base", "--is-ancestor", head, "origin/main"]).ok;
};

/**
 * Has `head`'s content already squash-merged into `origin/main`? A squash merge (ADR 0048)
 * rewrites the branch's commits into one new commit, so the tip is NOT a commit-ancestor and
 * `--is-ancestor` misses it (#1328). Detect it by patch-id equivalence: synthesize one dangling
 * commit carrying the branch's cumulative diff against its merge-base with `origin/main`, then
 * ask `git cherry` whether that change already exists upstream (`-` prefix ⇒ equivalent). Every
 * git failure collapses to `false` (fail-safe: reads as unpushed → KEEP).
 */
const squashMergedToOriginMain = (head: string | null): boolean => {
	if (head === null) return false;
	const base = runGit(["merge-base", "origin/main", head]);
	if (!base.ok) return false;
	const tree = runGit(["rev-parse", `${head}^{tree}`]);
	if (!tree.ok) return false;
	const dangling = runGit(["commit-tree", tree.stdout.trim(), "-p", base.stdout.trim(), "-m", "_"]);
	if (!dangling.ok) return false;
	const cherry = runGit(["cherry", "origin/main", dangling.stdout.trim()]);
	if (!cherry.ok) return false;
	return cherry.stdout.trimStart().startsWith("-");
};

/**
 * Does the tree hold unpushed commits — work not yet landed on `origin/main`? True unless its
 * HEAD content is reachable (a non-squash merge / merged commit) OR squash-merged. This is the
 * committed-work guard `git worktree remove` does NOT provide (the no-`--force` line only guards
 * UNcommitted changes) — it is what spares the #3754 observed case: a tree checked out at an
 * unpushed base. Fail-safe: an unresolvable ancestry reads unpushed → KEEP.
 */
const hasUnpushed = (head: string | null): boolean =>
	!(reachableFromOriginMain(head) || squashMergedToOriginMain(head));

const executeFlag = Flag.boolean("execute").pipe(
	Flag.withDescription("actually reap the orphaned worktrees (default: dry-run, print only)"),
);

const reasonLine = (path: string, reason: string): string => `  ${reason.padEnd(14)} ${path}`;

const worktreeReap = Command.make(
	"worktree-reap",
	{execute: executeFlag},
	Effect.fn(function* ({execute}) {
		const listed = runGit(["worktree", "list", "--porcelain"]);
		if (!listed.ok) {
			yield* Console.error(
				`worktree-reap: \`git worktree list\` failed — ${listed.stderr.trim() || "is this a git repo?"}`,
			);
			return yield* Effect.sync(() => process.exit(1));
		}

		const parsed = parseWorktreeList(listed.stdout);
		const candidates: ReadonlyArray<ReapCandidate> = parsed
			.filter((p) => !p.bare)
			.map((p) => {
				// Only a managed agent worktree with a provable crew-agent owner is probed for facts —
				// everything else short-circuits to a SPARE record (the classifier never consults the
				// other fields for it), so no `git status` / ancestry / pid probe fires on the primary
				// checkout or a foreign tree.
				const owner = isManagedAgentWorktree(p.path) ? parseAgentLockOwner(p.lockReason) : null;
				if (owner === null) {
					return {
						path: p.path,
						branch: p.branch,
						owner: null,
						hasUncommitted: false,
						hasUnpushed: false,
					};
				}
				const alive = pidAlive(owner.pid);
				// A LIVE session is spared regardless of tree state, so skip the costlier status/ancestry
				// probes for it — only a dead-session tree needs its recoverable-work facts gathered.
				if (alive) {
					return {
						path: p.path,
						branch: p.branch,
						owner: {pid: owner.pid, alive: true},
						hasUncommitted: false,
						hasUnpushed: false,
					};
				}
				return {
					path: p.path,
					branch: p.branch,
					owner: {pid: owner.pid, alive: false},
					hasUncommitted: worktreeHasUncommitted(p.path),
					hasUnpushed: hasUnpushed(p.head),
				};
			});

		const plan = computeWorktreeReapPlan(candidates);

		// ADR 0092 "emit what you scanned": the full plan is observable before any action.
		yield* Console.log(
			`worktree-reap: ${candidates.length} worktree(s) scanned — ${plan.toReap.length} orphaned-clean (reapable), ${plan.keptDirty.length} kept-dirty, ${plan.spared.length} spared${execute ? " (EXECUTE)" : " (dry-run)"}`,
		);
		if (plan.spared.length > 0) {
			yield* Console.log("spared:");
			for (const s of plan.spared) yield* Console.log(reasonLine(s.worktree.path, s.reason));
		}
		if (plan.keptDirty.length > 0) {
			yield* Console.log("kept-dirty (holds recoverable work — never reaped):");
			for (const k of plan.keptDirty) yield* Console.log(reasonLine(k.worktree.path, k.reason));
		}
		if (plan.toReap.length > 0) {
			yield* Console.log("orphaned-clean (reapable):");
			for (const r of plan.toReap)
				yield* Console.log(reasonLine(r.worktree.path, `pid ${r.worktree.owner?.pid ?? "?"} dead`));
		}

		if (!execute) {
			yield* Console.log("  (dry-run — pass --execute to reap; nothing touched)");
			return;
		}

		let reaped = 0;
		let refused = 0;
		const freedBranches: Array<string> = [];
		for (const r of plan.toReap) {
			const path = r.worktree.path;
			// The tree is locked with a stale pid-lock (its session is proven dead). Unlock it —
			// scoped to this classified-dead+clean tree — so the non-forced remove can proceed. This
			// unlock never touches a live lane: a live session was spared before ever reaching here.
			const unlocked = runGit(["worktree", "unlock", path]);
			if (!unlocked.ok) {
				// An already-unlocked tree reports failure here; that is benign — proceed to remove.
				const stderr = unlocked.stderr.trim();
				if (stderr && !/not locked/i.test(stderr)) {
					yield* Console.error(`  unlock warning ${path} — ${stderr}`);
				}
			}
			// NEVER --force: git refuses a tree it judges unsafe, and we KEEP it (report, don't escalate).
			const removed = runGit(["worktree", "remove", path]);
			if (removed.ok) {
				reaped += 1;
				if (r.worktree.branch !== null) freedBranches.push(r.worktree.branch);
				yield* Console.log(
					`  reaped ${path}${r.worktree.branch !== null ? ` (freed branch ${r.worktree.branch})` : ""}`,
				);
			} else {
				refused += 1;
				yield* Console.error(
					`  KEPT (git refused, never --force) ${path} — ${removed.stderr.trim()}`,
				);
			}
		}
		yield* Console.log(
			`worktree-reap: reaped ${reaped}, kept ${plan.keptDirty.length + refused}, spared ${plan.spared.length}` +
				(refused > 0 ? ` (${refused} reapable but refused by git → kept)` : "") +
				(freedBranches.length > 0 ? ` — freed branches: ${freedBranches.join(", ")}` : ""),
		);
	}),
).pipe(
	Command.withDescription(
		"Safe reaper for agent worktrees orphaned by DEAD crew sessions — session-presence-based (ADR 0191), clean+pushed only, never --force (#3754)",
	),
);

export const worktreeReapCommand = worktreeReap;
