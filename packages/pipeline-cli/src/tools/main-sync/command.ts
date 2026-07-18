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
 * TWO policies, one runnable surface:
 *   - default (drain-sync, #1494/#1573): AGGRESSIVE — reattaches a detached/off-`main`
 *     HEAD to `main` (clean tree only) before the merge, for the orchestrator's
 *     before/after-drain sync.
 *   - `--post-merge` (refresh, #2056): GENTLE — invoked by a pipeline step that knows a
 *     merge landed (ship-it / the orchestrator). It fast-forwards the primary when it is
 *     on `main` and free of tracked modifications (ff'ing through untracked-only dirt,
 *     #2455); on a non-`main` branch or a tree with tracked modifications it LEAVES
 *     THE CHECKOUT ALONE and exits 0 (never moves HEAD, never errors). This closes the
 *     silent-drift hazard under the merge queue (ADR 0132), where a PR lands GitHub-side
 *     with no local merge to advance the owner's checkout. See `decideMainRefresh`.
 *
 * DRY-RUN by default: with no flag it probes HEAD, prints the plan it WOULD run, and
 * exits 0 without touching anything (not even a fetch). `--execute` runs the plan. The
 * git IO uses `execFileSync` directly (mirrors `worktree-sweep` / the `worktree-guard`
 * reaper), so the tool's requirement stays at the Node platform ceiling the registry
 * provides.
 */
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {isControlPlaneDeletion, parseNameStatus} from "@kampus/primary-index-tripwire";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {
	changedPathsForceDepRefresh,
	decidePnpmVersionGuard,
	depPathsForcingRefresh,
	type PnpmVersion,
	parsePackageManagerPnpm,
	parsePnpmVersionOutput,
} from "./dep-refresh.ts";
import {decideMainRefresh, decideMainSync, type HeadState, MAIN_BRANCH} from "./main-sync.ts";

interface GitResult {
	readonly ok: boolean;
	readonly stdout: string;
	readonly stderr: string;
}

// A best-effort captured-output runner: a non-zero exit is fully absorbed into a {ok:false}
// GitResult the caller branches on, never the E channel — a total helper, not Effect-cosplay.
const runCaptured = (cmd: string, args: ReadonlyArray<string>, cwd?: string): GitResult => {
	// biome-ignore lint/plugin: see the note above — total by construction, the E channel is never used.
	try {
		const stdout = execFileSync(cmd, [...args], {encoding: "utf8", ...(cwd ? {cwd} : {})});
		return {ok: true, stdout, stderr: ""};
	} catch (cause) {
		const e = cause as {stdout?: Buffer | string; stderr?: Buffer | string};
		return {ok: false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "")};
	}
};

const runGit = (args: ReadonlyArray<string>): GitResult => runCaptured("git", args);

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

/**
 * `git status --porcelain -uno` non-empty ⇒ TRACKED modifications (staged/unstaged) — `-uno`
 * excludes untracked files. Indeterminate (command failed) ⇒ true (fail-safe: treat an
 * unreadable tree as tracked-dirty so the refresh leaves it alone). See #2455: the post-merge
 * refresh ff's through untracked-only dirt but must still refuse on tracked modifications a
 * fast-forward could clobber, so `decideMainRefresh` consults THIS, not `isDirty`.
 */
const treeHasTrackedModifications = (): boolean => {
	const r = runGit(["status", "--porcelain", "-uno"]);
	if (!r.ok) return true;
	return r.stdout.trim() !== "";
};

/**
 * The count of staged deletions under the instruction-trust prefixes — the #2778 signature (#2784),
 * classified with `@kampus/primary-index-tripwire`'s detection so main-sync's guaranteed refusal and
 * the §CP `primary-index-guard` block share one definition. Indeterminate probe (command failed) ⇒ 0:
 * this count only ever TIGHTENS the guard (a positive count refuses), so a 0 fallback never
 * false-refuses; the incidental dirty checks still stand behind it.
 */
const stagedControlPlaneDeletionCount = (): number => {
	const r = runGit(["diff", "--cached", "--name-status", "--diff-filter=D"]);
	if (!r.ok) return 0;
	return parseNameStatus(r.stdout).filter((e) => isControlPlaneDeletion(e.path)).length;
};

/** The primary checkout's toplevel — where package.json lives and the install must run. `null` if git can't resolve it. */
const repoRoot = (): string | null => {
	const r = runGit(["rev-parse", "--show-toplevel"]);
	return r.ok && r.stdout.trim() !== "" ? r.stdout.trim() : null;
};

/** The `packageManager` pin from the root package.json, or `undefined` if unreadable/absent. */
const readPackageManagerPin = (root: string): string | undefined => {
	// biome-ignore lint/plugin: total pre-runtime helper — a missing file / bad JSON maps to `undefined`, which the guard treats as unresolved-required (fail-closed); no E channel to model.
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			packageManager?: string;
		};
		return pkg.packageManager;
	} catch {
		return undefined;
	}
};

/**
 * Re-install deps after a ff merge IFF the merge pulled a `patches/**`/`pnpm-lock.yaml`
 * change — the #3498 fix. Without it the ff advances the SOURCE patch/lockfile but not the
 * installed `.pnpm/…/patched` copy the runtime executes, so a re-booted crew silently runs
 * the PRE-merge patched dep (a merged fix reads as "still broken"). Resolves pnpm via corepack
 * against the repo's `packageManager` pin — NEVER a bare-PATH pnpm, whose wrong major silently
 * leaves a stale patched dir — and FAILS LOUD (exit 1) if it can't resolve the pinned pnpm, the
 * resolved major mismatches the repo requirement, or the frozen install fails. `preSha` is HEAD
 * captured immediately before the merge, so `preSha..HEAD` is exactly what the ff pulled.
 */
const refreshDepsAfterMerge = Effect.fn(function* (preSha: string) {
	const diff = runGit(["diff", "--name-only", preSha, "HEAD"]);
	const changed = diff.ok
		? diff.stdout
				.split("\n")
				.map((s) => s.trim())
				.filter((s) => s !== "")
		: [];
	const forcing = depPathsForcingRefresh(changed);
	if (!changedPathsForceDepRefresh(changed)) {
		yield* Console.log(
			"  dep refresh: the merge pulled no patches/** or pnpm-lock.yaml change — installed node_modules is current, nothing to re-install.",
		);
		return;
	}

	yield* Console.log(
		`  dep refresh: the merge pulled ${forcing.length} dep-input change(s) (${forcing.join(", ")}) — installed node_modules is now STALE, re-installing with the repo-pinned pnpm.`,
	);

	const root = repoRoot();
	if (root === null) {
		yield* Console.error(
			`main-sync dep refresh FAILED (fail-closed): the merge changed ${forcing.join(", ")} but the repo root is unresolvable — refusing to install under an unknown root. node_modules is STALE (#3498); provision the pinned pnpm and re-run.`,
		);
		return yield* Effect.sync(() => process.exit(1));
	}

	const required = parsePackageManagerPnpm(readPackageManagerPin(root));
	// Resolve pnpm via corepack AGAINST THE PIN (`corepack pnpm@<version> …`), never the bare-PATH
	// pnpm — the wrong-major hazard #3498 exists to close. A failed probe ⇒ unresolved ⇒ fail-closed.
	let resolved: PnpmVersion | null = null;
	if (required !== null) {
		const ver = runCaptured("corepack", [`pnpm@${required.version}`, "--version"], root);
		resolved = ver.ok ? parsePnpmVersionOutput(ver.stdout) : null;
	}
	const guard = decidePnpmVersionGuard(required, resolved);
	if (!guard.ok) {
		const detail =
			guard.reason === "unresolved-required"
				? "the root package.json `packageManager` pin is absent or unparseable — cannot determine the required pnpm major"
				: guard.reason === "unresolved-pnpm"
					? "could not resolve the repo-pinned pnpm via corepack (corepack absent or errored) — refusing to fall back to a bare-PATH pnpm, whose wrong major silently leaves a stale patched dir"
					: `resolved pnpm ${guard.resolved.version} (major ${guard.resolved.major}) does NOT match the repo-required major ${guard.required.major} (${guard.required.version}) — a wrong-major install silently leaves a stale patched dir`;
		const provision = required
			? `corepack pnpm@${required.version} install --frozen-lockfile`
			: "corepack pnpm install --frozen-lockfile";
		yield* Console.error(
			`main-sync dep refresh FAILED (fail-closed): the merge changed ${forcing.join(", ")} but ${detail}. node_modules is STALE and a re-booted crew would run the PRE-merge patched dep (#3498). Provision with the pinned pnpm (\`${provision}\`) and re-run.`,
		);
		return yield* Effect.sync(() => process.exit(1));
	}

	yield* Console.log(
		`  dep refresh: resolved pnpm ${guard.resolved.version} via corepack (matches the pinned major ${guard.resolved.major}) — running the frozen-lockfile install.`,
	);
	const installed = runCaptured(
		"corepack",
		[`pnpm@${guard.resolved.version}`, "install", "--frozen-lockfile"],
		root,
	);
	if (!installed.ok) {
		yield* Console.error(
			`main-sync dep refresh FAILED (fail-closed): \`corepack pnpm@${guard.resolved.version} install --frozen-lockfile\` exited non-zero — ${installed.stderr.trim() || "install error"}. node_modules may be STALE (#3498). Resolve the install by hand before booting the crew.`,
		);
		return yield* Effect.sync(() => process.exit(1));
	}
	yield* Console.log(
		"  dep refresh: re-installed with the pinned pnpm — installed node_modules now matches the merged patches/lockfile.",
	);
});

/**
 * The gentle post-merge refresh (#2056) — the HEAD-preserving counterpart to the drain-sync
 * below. `decideMainRefresh` is the safety policy; this runs it. A `leave-alone` plan is a
 * clean exit-0 no-op (the whole point: a stale checkout is acceptable, disturbing the owner
 * is not), so it NEVER errors — only a genuine fetch/merge failure on the fast-forward path
 * exits non-zero.
 */
const runPostMergeRefresh = Effect.fn(function* (head: HeadState, execute: boolean) {
	const plan = decideMainRefresh(head);

	// ADR 0092 "emit what you scanned": the HEAD state + plan are observable before any action.
	// Report the tracked/untracked distinction the refresh actually gates on (#2455), not bare dirt.
	const treeLabel = head.hasTrackedModifications
		? "tracked-modified"
		: head.isDirty
			? "untracked-only (ff-safe)"
			: "clean";
	yield* Console.log(
		`main-sync --post-merge: HEAD ${head.branch ?? "(detached)"}, tree ${treeLabel} — plan: ${plan.action}${execute ? " (EXECUTE)" : " (dry-run)"}`,
	);

	if (plan.action === "refuse-mass-deletion") {
		// The one refresh outcome that is LOUD (exit 1), not a silent no-op: the #2778 loaded-gun
		// state must surface, never be skipped as ordinary dirt (#2784).
		yield* Console.error(
			`main-sync --post-merge REFUSED (fail-closed): the primary index carries ${plan.count} control-plane staged deletion(s) — the #2778 mass-staged-deletion signature. Refusing to refresh a primary in the loaded-gun state (a commit + push would fast-forward this control-plane mass deletion to origin/main). Unstage and recover by hand (0 commits ahead ⇒ \`git reset --hard origin/main\`), then re-run.`,
		);
		return yield* Effect.sync(() => process.exit(1));
	}

	if (plan.action === "leave-alone") {
		yield* Console.log(
			`  leaving the primary checkout ALONE (${plan.reason === "off-main" ? `on '${plan.branch}', not '${MAIN_BRANCH}'` : "tree has tracked modifications"}) — a fast-forward would ${plan.reason === "off-main" ? "not advance a checked-out feature branch" : "risk clobbering tracked work"}. No-op (stale is acceptable; clobbering is not).`,
		);
		return;
	}

	if (!execute) {
		yield* Console.log(
			`  would refresh: git fetch origin ${MAIN_BRANCH} && git merge --ff-only origin/${MAIN_BRANCH}`,
		);
		yield* Console.log(
			"  would then, IF the ff pulls a patches/** or pnpm-lock.yaml change: re-install with the repo-pinned pnpm via corepack (or fail loud) — #3498",
		);
		yield* Console.log("  (dry-run — pass --execute to run; nothing touched)");
		return;
	}

	const fetched = runGit(["fetch", "origin", MAIN_BRANCH]);
	if (!fetched.ok) {
		yield* Console.error(
			`main-sync --post-merge: \`git fetch origin ${MAIN_BRANCH}\` failed — ${fetched.stderr.trim() || "network?"}`,
		);
		return yield* Effect.sync(() => process.exit(1));
	}

	// HEAD before the merge, so refreshDepsAfterMerge diffs exactly what the ff pulled (#3498).
	const preSha = runGit(["rev-parse", "HEAD"]).stdout.trim();
	// --ff-only is the invariant that makes the refresh safe: it advances main to origin/main
	// when it's a strict fast-forward and ABORTS on any divergence — never a merge commit,
	// never a force. On a clean 'main' the worst case is a no-op, never a clobber (#2056).
	const merged = runGit(["merge", "--ff-only", `origin/${MAIN_BRANCH}`]);
	if (!merged.ok) {
		yield* Console.error(
			`main-sync --post-merge: \`git merge --ff-only origin/${MAIN_BRANCH}\` failed — ${merged.stderr.trim() || "not fast-forwardable"}. The primary has diverged; resolve by hand.`,
		);
		return yield* Effect.sync(() => process.exit(1));
	}
	yield* Console.log(
		`main-sync --post-merge: primary checkout fast-forwarded to origin/${MAIN_BRANCH}.`,
	);
	yield* refreshDepsAfterMerge(preSha);
});

const executeFlag = Flag.boolean("execute").pipe(
	Flag.withDescription(
		"actually reattach (if detached+clean) and run fetch + merge --ff-only (default: dry-run, print the plan only)",
	),
);

const postMergeFlag = Flag.boolean("post-merge").pipe(
	Flag.withDescription(
		"gentle post-merge refresh (#2056): fast-forward on 'main' when free of tracked modifications (ff's through untracked-only dirt, #2455); on any other branch or a tree with tracked modifications, leave the checkout alone and exit 0 (never reattach, never error)",
	),
);

const mainSync = Command.make(
	"main-sync",
	{execute: executeFlag, postMerge: postMergeFlag},
	Effect.fn(function* ({execute, postMerge}) {
		const head: HeadState = {
			branch: headBranch(),
			isDirty: treeIsDirty(),
			hasTrackedModifications: treeHasTrackedModifications(),
			stagedControlPlaneDeletionCount: stagedControlPlaneDeletionCount(),
		};

		if (postMerge) {
			return yield* runPostMergeRefresh(head, execute);
		}

		const plan = decideMainSync(head);

		// ADR 0092 "emit what you scanned": the HEAD state + plan are observable before any action.
		yield* Console.log(
			`main-sync: HEAD ${head.branch ?? "(detached)"}, tree ${head.isDirty ? "DIRTY" : "clean"} — plan: ${plan.action}${execute ? " (EXECUTE)" : " (dry-run)"}`,
		);

		if (plan.action === "blocked-mass-deletion") {
			// The guaranteed catch (#2784): refuse by NAME on the #2778 signature, before any reattach
			// or merge — not the incidental dirty gate. Detection + refusal only, never a `git reset`.
			yield* Console.error(
				`main-sync REFUSED (fail-closed): the primary index carries ${plan.count} control-plane staged deletion(s) — the #2778 mass-staged-deletion signature. Refusing to sync a primary in the loaded-gun state (a commit + push would fast-forward this control-plane mass deletion to origin/main). Unstage and recover by hand (0 commits ahead ⇒ \`git reset --hard origin/main\`), then re-run.`,
			);
			return yield* Effect.sync(() => process.exit(1));
		}

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
			yield* Console.log(
				"  would then, IF the ff pulls a patches/** or pnpm-lock.yaml change: re-install with the repo-pinned pnpm via corepack (or fail loud) — #3498",
			);
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

		// HEAD before the merge, so refreshDepsAfterMerge diffs exactly what the ff pulled (#3498).
		const preSha = runGit(["rev-parse", "HEAD"]).stdout.trim();
		const merged = runGit(["merge", "--ff-only", `origin/${MAIN_BRANCH}`]);
		if (!merged.ok) {
			yield* Console.error(
				`main-sync: \`git merge --ff-only origin/${MAIN_BRANCH}\` failed — ${merged.stderr.trim() || "not fast-forwardable"}. The primary has diverged; resolve by hand.`,
			);
			return yield* Effect.sync(() => process.exit(1));
		}
		yield* Console.log(`main-sync: primary checkout synced to origin/${MAIN_BRANCH}.`);
		yield* refreshDepsAfterMerge(preSha);
	}),
).pipe(
	Command.withDescription(
		"Codified primary main-sync. Default (drain-sync): auto-reattach a detached primary HEAD to main, then fetch + merge --ff-only; refuses on a dirty tree (#1573 / #1494 Unit C). --post-merge (refresh): fast-forward on main when free of tracked modifications (ff's through untracked-only dirt, #2455), else leave the checkout alone and exit 0 (#2056).",
	),
);

export const mainSyncCommand = mainSync;
