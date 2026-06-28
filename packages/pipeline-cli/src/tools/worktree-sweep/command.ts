/**
 * The `worktree-sweep` tool — `pipeline-cli worktree-sweep [--execute]`.
 *
 * The sanctioned, safe-by-default bulk drain for accumulated agent worktrees under
 * `.claude/worktrees/` (issue #1243). The harness does not auto-remove a worktree
 * that made commits, so they pile up without bound and slow every git op. This
 * command enumerates them, classifies each via the pure core (`worktree-sweep.ts`),
 * prints the plan, and — ONLY with `--execute` — runs `git worktree remove` (NEVER
 * `--force`) on the removable set.
 *
 * Safe by construction (two enforcement lines):
 *   1. The pure classifier only marks a worktree removable when it is CLEAN AND its
 *      HEAD is reachable from `origin/main`; dirty / unmerged trees are KEPT, so a
 *      live agent's in-flight branch is never swept.
 *   2. `git worktree remove` runs WITHOUT `--force` — git itself refuses a tree it
 *      judges unsafe (dirty/locked/current), and that refusal is caught and reported
 *      as KEPT, never escalated.
 *
 * DRY-RUN by default: with no flag it prints what it WOULD remove and exits 0
 * without touching anything. The git IO uses `execFileSync` directly (mirrors the
 * `worktree-guard` reaper), so the tool's requirement stays at the Node platform
 * ceiling the registry provides.
 */
import {execFileSync} from "node:child_process";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {
	computeWorktreeSweepPlan,
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
				const reachable = reachableFromOriginMain(p.head);
				return {
					path: p.path,
					branch: p.branch,
					isDirty: worktreeIsDirty(p.path),
					reachableFromOriginMain: reachable,
					// Only probe the costlier squash signal when ancestry already missed.
					squashMergedToOriginMain: reachable ? false : squashMergedToOriginMain(p.head),
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
		"Safe bulk drain of accumulated .claude/worktrees/ agent worktrees — clean+merged only, never --force (#1243)",
	),
);

export const worktreeSweepCommand = worktreeSweep;
