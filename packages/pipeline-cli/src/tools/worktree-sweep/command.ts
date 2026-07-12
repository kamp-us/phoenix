/**
 * The `worktree-sweep` tool — `pipeline-cli worktree-sweep [--execute]`.
 *
 * The sanctioned, safe-by-default bulk drain for accumulated agent worktrees (issue
 * #1243). It sweeps two leaked classes (#2785): the harness-provisioned build trees under
 * `.claude/worktrees/`, and the `$TMPDIR`-rooted `review-head-*` detached checkouts the
 * review gates materialize. The harness does not auto-remove a build tree that made commits,
 * and nothing at all reclaims a review-head tree, so both pile up without bound and slow every
 * git op. This command enumerates them, classifies each via the pure core (`worktree-sweep.ts`),
 * prints the plan, and — ONLY with `--execute` — runs `git worktree remove` (NEVER `--force`)
 * on the removable set.
 *
 * Safe by construction (enforcement lines):
 *   1. The pure classifier only marks a worktree removable when it is CLEAN, reachable
 *      from `origin/main`, AND provably not-in-use — unlocked, mtime-idle past a
 *      threshold, and with no open PR (the #2240 liveness guard). Dirty / unmerged /
 *      live trees are KEPT, so a running sibling lane is never swept.
 *   2. `git worktree remove` runs WITHOUT `--force` — git itself refuses a tree it
 *      judges unsafe (dirty/locked/current), and that refusal is caught and reported
 *      as KEPT, never escalated. This is a dirty-work guard, orthogonal to liveness
 *      (git does NOT refuse a clean tree a *sibling* holds as CWD — #2240) — the
 *      classifier's liveness gate is what covers the concurrent-sibling case.
 *
 * DRY-RUN by default: with no flag it prints what it WOULD remove and exits 0
 * without touching anything. The git IO uses `execFileSync` directly (mirrors the
 * `worktree-guard` reaper), so the tool's requirement stays at the Node platform
 * ceiling the registry provides.
 */
import {execFileSync} from "node:child_process";
import {statSync} from "node:fs";
import {join} from "node:path";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {
	computeWorktreeSweepPlan,
	isManagedWorktree,
	isReviewHeadWorktree,
	parseWorktreeList,
	type WorktreeRecord,
} from "./worktree-sweep.ts";

interface GitResult {
	readonly ok: boolean;
	readonly stdout: string;
	readonly stderr: string;
}

const runGit = (args: ReadonlyArray<string>): GitResult => {
	try {
		const stdout = execFileSync("git", [...args], {encoding: "utf8"});
		return {ok: true, stdout, stderr: ""};
	} catch (cause) {
		const e = cause as {stdout?: Buffer | string; stderr?: Buffer | string};
		return {ok: false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "")};
	}
};

/** `git status --porcelain` non-empty ⇒ dirty. Indeterminate (command failed) ⇒ dirty (fail-safe KEEP). */
const worktreeIsDirty = (path: string): boolean => {
	const r = runGit(["-C", path, "status", "--porcelain"]);
	if (!r.ok) return true;
	return r.stdout.trim() !== "";
};

/**
 * Is `head` reachable from `origin/main`? `git merge-base --is-ancestor` exits 0
 * when it is, 1 when not, and non-zero (128) when a ref can't be resolved — all the
 * non-zero cases collapse to "not reachable", which the classifier treats as KEEP.
 * So a missing `origin/main` fails safe toward keeping every worktree.
 */
const reachableFromOriginMain = (head: string | null): boolean => {
	if (head === null) return false;
	return runGit(["merge-base", "--is-ancestor", head, "origin/main"]).ok;
};

/**
 * Has `head`'s content already squash-merged into `origin/main`? A squash merge
 * (ADR 0048) rewrites the branch's commits into one new commit, so the branch tip is
 * NOT a commit-ancestor of `origin/main` and `--is-ancestor` misses it (#1328). This
 * detects it by patch-id equivalence: synthesize a single dangling commit carrying the
 * branch's *cumulative* diff against its merge-base with `origin/main`, then ask `git
 * cherry` whether that change already exists upstream. A leading `-` means equivalent
 * (squash-merged); `+` means genuinely unmerged. Every git failure collapses to
 * `false` (fail-safe KEEP), so an unconfigured committer identity or a missing
 * `origin/main` never causes a spurious remove.
 *
 * Why a synthetic single commit and not bare `git cherry origin/main <branch>`:
 * per-commit patch-ids don't match a squash that fused several commits into one, so
 * the cumulative-diff commit is what makes the equivalence detectable.
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

/** A managed worktree untouched this long is presumed orphaned, not a live lane (#2240). */
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;

/** Newest mtime (ms) among the given paths, or `null` when none can be stat'd. */
const newestMtimeMs = (paths: ReadonlyArray<string>): number | null => {
	let newest: number | null = null;
	for (const p of paths) {
		try {
			const m = statSync(p).mtimeMs;
			if (newest === null || m > newest) newest = m;
		} catch {
			// path absent/unreadable — skip; a wholly unresolvable set falls to the null fail-safe below.
		}
	}
	return newest;
};

/**
 * Is a managed worktree still LIVE by recency (#2240)? Probes the worktree dir + its
 * per-tree `HEAD` and `logs/HEAD` — a commit/checkout bumps HEAD and appends the reflog,
 * a new file bumps the dir; a still-editing lane is caught earlier as `dirty`. The index
 * is deliberately NOT probed: `git status` (the dirty check) can rewrite it, which would
 * mask idleness. Any unresolvable mtime ⇒ presumed active (fail-safe KEEP).
 */
const worktreeRecentlyActive = (path: string): boolean => {
	const gitdir = runGit(["-C", path, "rev-parse", "--absolute-git-dir"]);
	const probes = [path];
	if (gitdir.ok) {
		const g = gitdir.stdout.trim();
		probes.push(join(g, "HEAD"), join(g, "logs", "HEAD"));
	}
	const newest = newestMtimeMs(probes);
	if (newest === null) return true;
	return Date.now() - newest < IDLE_THRESHOLD_MS;
};

const runGh = (args: ReadonlyArray<string>): GitResult => {
	try {
		const stdout = execFileSync("gh", [...args], {encoding: "utf8"});
		return {ok: true, stdout, stderr: ""};
	} catch (cause) {
		const e = cause as {stdout?: Buffer | string; stderr?: Buffer | string};
		return {ok: false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "")};
	}
};

/** `owner/repo` from a github.com remote URL (ssh or https), or `null` for a non-GitHub remote. */
const githubSlug = (url: string): string | null => {
	const m = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
	return m ? `${m[1]}/${m[2]}` : null;
};

/**
 * Does `branch` have an OPEN PR on the GitHub origin (#2240)? An open PR marks an
 * in-flight lane → KEEP. Meaningful only for a GitHub origin: a non-GitHub / absent
 * origin (a local test repo) has no PR concept, so this signal is N/A there and the
 * mtime-idle + locked guards carry liveness. When origin IS GitHub, ANY resolution or
 * query failure is fail-safe toward KEEP (returns `true`). Queried per REST (never
 * GraphQL — the org's Projects-classic integration errors GraphQL PR queries).
 */
const branchHasOpenPr = (branch: string | null): boolean => {
	if (branch === null) return false;
	const remote = runGit(["remote", "get-url", "origin"]);
	if (!remote.ok) return false;
	const slug = githubSlug(remote.stdout.trim());
	if (slug === null) return false;
	const owner = slug.split("/")[0];
	const r = runGh([
		"api",
		`repos/${slug}/pulls?head=${owner}:${branch}&state=open&per_page=1`,
		"--jq",
		"length",
	]);
	if (!r.ok) return true;
	const n = Number.parseInt(r.stdout.trim(), 10);
	if (!Number.isFinite(n)) return true;
	return n > 0;
};

const executeFlag = Flag.boolean("execute").pipe(
	Flag.withDescription("actually remove the removable worktrees (default: dry-run, print only)"),
);

const reasonLine = (path: string, reason: string): string => `  ${reason.padEnd(20)} ${path}`;

const worktreeSweep = Command.make(
	"worktree-sweep",
	{execute: executeFlag},
	Effect.fn(function* ({execute}) {
		const listed = runGit(["worktree", "list", "--porcelain"]);
		if (!listed.ok) {
			yield* Console.error(
				`worktree-sweep: \`git worktree list\` failed — ${listed.stderr.trim() || "is this a git repo?"}`,
			);
			return yield* Effect.sync(() => process.exit(1));
		}

		const parsed = parseWorktreeList(listed.stdout);
		const records: ReadonlyArray<WorktreeRecord> = parsed
			.filter((p) => !p.bare)
			.map((p) => {
				const managed = isManagedWorktree(p.path);
				// A review-head tree is a swept candidate too (#2785), so its liveness (idle mtime)
				// must be probed. Its detached HEAD carries no branch, so the open-PR probe below
				// (branch-keyed) is N/A for it — the dirty/locked/idle triple carries its liveness.
				const swept = managed || isReviewHeadWorktree(p.path);
				const isDirty = worktreeIsDirty(p.path);
				const reachable = reachableFromOriginMain(p.head);
				// Only probe the costlier squash signal when ancestry already missed.
				const squashMerged = reachable ? false : squashMergedToOriginMain(p.head);
				const recentlyActive = swept ? worktreeRecentlyActive(p.path) : false;
				// The network open-PR probe fires ONLY for a BUILD tree that would otherwise be swept —
				// managed, clean, unlocked, idle, and content-merged — so SessionStart makes at most
				// one gh call per reap candidate (usually zero), never one per worktree. A review-head
				// tree never enters here (no branch, and its classifier branch precedes the open-PR gate).
				const wouldRemove =
					managed && !isDirty && !p.locked && !recentlyActive && (reachable || squashMerged);
				const hasOpenPr = wouldRemove ? branchHasOpenPr(p.branch) : false;
				return {
					path: p.path,
					branch: p.branch,
					isDirty,
					reachableFromOriginMain: reachable,
					squashMergedToOriginMain: squashMerged,
					locked: p.locked,
					recentlyActive,
					hasOpenPr,
				};
			});

		const plan = computeWorktreeSweepPlan(records);

		// ADR 0092 "emit what you scanned": the full plan is observable before any action.
		yield* Console.log(
			`worktree-sweep: ${records.length} worktree(s) scanned — ${plan.toRemove.length} removable, ${plan.kept.length} kept${execute ? " (EXECUTE)" : " (dry-run)"}`,
		);
		if (plan.kept.length > 0) {
			yield* Console.log("kept:");
			for (const k of plan.kept) yield* Console.log(reasonLine(k.worktree.path, k.reason));
		}
		if (plan.toRemove.length > 0) {
			yield* Console.log("removable:");
			for (const r of plan.toRemove) yield* Console.log(reasonLine(r.worktree.path, r.reason));
		}

		if (!execute) {
			yield* Console.log("  (dry-run — pass --execute to remove; nothing touched)");
			return;
		}

		let removed = 0;
		let refused = 0;
		for (const r of plan.toRemove) {
			// NEVER --force: git refuses a tree it judges unsafe, and we KEEP it (report, don't escalate).
			const res = runGit(["worktree", "remove", r.worktree.path]);
			if (res.ok) {
				removed += 1;
				yield* Console.log(`  removed ${r.worktree.path}`);
			} else {
				refused += 1;
				yield* Console.error(
					`  KEPT (git refused, never --force) ${r.worktree.path} — ${res.stderr.trim()}`,
				);
			}
		}
		yield* Console.log(
			`worktree-sweep: removed ${removed}, kept ${plan.kept.length + refused}` +
				(refused > 0 ? ` (${refused} removable but refused by git → kept)` : ""),
		);
	}),
).pipe(
	Command.withDescription(
		"Safe bulk drain of accumulated agent build worktrees + leaked review-head checkouts — clean+idle only, never --force (#1243/#2785)",
	),
);

export const worktreeSweepCommand = worktreeSweep;
