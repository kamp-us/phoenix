/**
 * The `main-sync` tool — `pipeline-cli main-sync [--execute]`.
 *
 * The codified, safe-by-default orchestrator main-sync for the shared primary
 * checkout (issue #1573, Unit C of the #1494 diagnosis). Replaces the hand-run
 * `git fetch origin main && git merge --ff-only origin/main` that lived only in
 * operator memory — and, crucially, AUTO-REATTACHES a detached primary HEAD to
 * `main` before the merge, so a stray detach during a heavy parallel drain can't
 * wedge an unattended overnight sync. The orchestrator runs this before/after a
 * drain instead of a human noticing the "Not possible to fast-forward" stall.
 *
 * Safe by construction (the pure core `main-sync.ts` is the first enforcement line,
 * this command's flow is the second):
 *   1. The pure `decideMainSync` authorizes a reattach `git checkout main` ONLY when
 *      the tree is CLEAN. A dirty off-`main` HEAD is DETECT-AND-SURFACE (`blocked-dirty`):
 *      the command refuses to `checkout` and surfaces the dirt, never discarding work —
 *      consistent with the #1494 incidents, which were always clean.
 *   2. The sync merge is `git merge --ff-only origin/main` — fast-forward only, so it
 *      never creates a merge commit and fails loudly rather than diverging the primary.
 *
 * DRY-RUN by default: with no flag it probes HEAD, prints the plan it WOULD run, and
 * exits 0 without touching anything (not even a fetch). `--execute` runs the plan:
 * reattach if authorized, then `fetch` + `merge --ff-only`. The git IO uses
 * `execFileSync` directly (mirrors `worktree-sweep` / the `worktree-guard` reaper),
 * so the tool's requirement stays at the Node platform ceiling the registry provides.
 */
import {execFileSync} from "node:child_process";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {decideMainSync, type HeadState, MAIN_BRANCH} from "./main-sync.ts";

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

/**
 * The short branch the primary HEAD points at, or `null` for a detached HEAD.
 * `git rev-parse --abbrev-ref HEAD` prints the literal `HEAD` when detached; an
 * indeterminate probe (command failed) also reads `null` — fail-safe toward
 * "needs attention", never a false "on main".
 */
const headBranch = (): string | null => {
	const r = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!r.ok) return null;
	const name = r.stdout.trim();
	return name === "" || name === "HEAD" ? null : name;
};

/** `git status --porcelain` non-empty ⇒ dirty. Indeterminate (command failed) ⇒ dirty (fail-safe: refuse reattach). */
const treeIsDirty = (): boolean => {
	const r = runGit(["status", "--porcelain"]);
	if (!r.ok) return true;
	return r.stdout.trim() !== "";
};

const executeFlag = Flag.boolean("execute").pipe(
	Flag.withDescription(
		"actually reattach (if detached+clean) and run fetch + merge --ff-only (default: dry-run, print the plan only)",
	),
);

const mainSync = Command.make(
	"main-sync",
	{execute: executeFlag},
	Effect.fn(function* ({execute}) {
		const head: HeadState = {branch: headBranch(), isDirty: treeIsDirty()};
		const plan = decideMainSync(head);

		// ADR 0092 "emit what you scanned": the HEAD state + plan are observable before any action.
		yield* Console.log(
			`main-sync: HEAD ${head.branch ?? "(detached)"}, tree ${head.isDirty ? "DIRTY" : "clean"} — plan: ${plan.action}${execute ? " (EXECUTE)" : " (dry-run)"}`,
		);

		if (plan.action === "blocked-dirty") {
			// Detect-and-surface, never discard: refuse the reattach on a dirty tree (#1494 AC #3).
			yield* Console.error(
				`main-sync: primary HEAD is off '${MAIN_BRANCH}' (from ${plan.from}) but the working tree is DIRTY — refusing to reattach (a checkout could discard uncommitted work). Resolve the tree by hand, then re-run.`,
			);
			return yield* Effect.sync(() => process.exit(1));
		}

		if (!execute) {
			if (plan.action === "reattach") {
				yield* Console.log(
					`  would reattach: git checkout ${MAIN_BRANCH} (from ${plan.from}), then fetch + merge --ff-only origin/${MAIN_BRANCH}`,
				);
			} else {
				yield* Console.log(
					`  would sync: git fetch origin ${MAIN_BRANCH} && git merge --ff-only origin/${MAIN_BRANCH}`,
				);
			}
			yield* Console.log("  (dry-run — pass --execute to run; nothing touched)");
			return;
		}

		if (plan.action === "reattach") {
			const co = runGit(["checkout", MAIN_BRANCH]);
			if (!co.ok) {
				yield* Console.error(
					`main-sync: reattach \`git checkout ${MAIN_BRANCH}\` failed — ${co.stderr.trim() || "unknown error"}`,
				);
				return yield* Effect.sync(() => process.exit(1));
			}
			yield* Console.log(`  reattached: ${plan.from} → ${MAIN_BRANCH}`);
		}

		const fetched = runGit(["fetch", "origin", MAIN_BRANCH]);
		if (!fetched.ok) {
			yield* Console.error(
				`main-sync: \`git fetch origin ${MAIN_BRANCH}\` failed — ${fetched.stderr.trim() || "network?"}`,
			);
			return yield* Effect.sync(() => process.exit(1));
		}

		const merged = runGit(["merge", "--ff-only", `origin/${MAIN_BRANCH}`]);
		if (!merged.ok) {
			yield* Console.error(
				`main-sync: \`git merge --ff-only origin/${MAIN_BRANCH}\` failed — ${merged.stderr.trim() || "not fast-forwardable"}. The primary has diverged; resolve by hand.`,
			);
			return yield* Effect.sync(() => process.exit(1));
		}
		yield* Console.log(`main-sync: primary checkout synced to origin/${MAIN_BRANCH}.`);
	}),
).pipe(
	Command.withDescription(
		"Codified orchestrator main-sync — auto-reattach a detached primary HEAD to main, then fetch + merge --ff-only; refuses on a dirty tree (#1573 / #1494 Unit C)",
	),
);

export const mainSyncCommand = mainSync;
