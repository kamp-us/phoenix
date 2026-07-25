/**
 * The `worktree-sweep` tool — `pipeline-cli worktree-sweep [--execute]`.
 *
 * The sanctioned, safe-by-default bulk drain for accumulated agent worktrees (issue
 * #1243). It sweeps three leaked classes (#2785, #3654): the harness-provisioned build trees
 * under `.claude/worktrees/`, the `$TMPDIR`-rooted `review-head-*` detached checkouts the
 * review gates materialize, and gone-dir trees — ANY tree whose working directory is already
 * missing, leaving only stale `.git/worktrees/<id>` metadata (the cross-session pile). The
 * harness does not auto-remove a build tree that made commits, nothing reclaims a review-head
 * tree, and nothing prunes a tree whose session temp-root was cleaned out from under it, so all
 * three pile up without bound and slow every git op. This command enumerates them, classifies
 * each via the pure core (`worktree-sweep.ts`), prints the plan, and — ONLY with `--execute` —
 * runs `git worktree remove` (NEVER `--force`) on the removable set and `git worktree prune`
 * for the gone-dir metadata.
 *
 * Safe by construction (enforcement lines):
 *   1. The pure classifier only marks a worktree removable when it is CLEAN, reachable
 *      from `origin/main`, AND provably not-in-use — its owning session provably DEAD
 *      (#3943), unlocked, mtime-idle past a threshold, and with no open PR (the #2240
 *      liveness guard). Dirty / unmerged / live / can't-prove-dead trees are KEPT, so a
 *      running sibling lane is never swept.
 *   2. `git worktree remove` runs WITHOUT `--force` — git itself refuses a tree it
 *      judges unsafe (dirty/locked/current), and that refusal is caught and reported
 *      as KEPT, never escalated. This is a dirty-work guard, orthogonal to liveness
 *      (git does NOT refuse a clean tree a *sibling* holds as CWD — #2240) — the
 *      classifier's liveness gate is what covers the concurrent-sibling case.
 *
 * DRY-RUN by default: with no flag it prints what it WOULD remove and exits 0
 * without touching anything. The git/gh IO uses `execFileSync` directly (mirrors the
 * `worktree-guard` reaper) — a subprocess boundary the platform services do not cover;
 * the file/path IO crosses the Effect `FileSystem`/`Path` seam
 * (.patterns/effect-platform-access.md, #3473).
 */
import {execFileSync} from "node:child_process";
import {homedir} from "node:os";
import {Console, Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {
	liveSessionIds,
	type OwnerLiveness,
	type OwnerStamp,
	parseOwnerStamp,
	parseSessionRegistryEntry,
	resolveOwnerLiveness,
	sessionIdFromPath,
} from "./owner-liveness.ts";
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
	// biome-ignore lint/plugin: best-effort git shell — a non-zero exit is fully absorbed into a {ok:false} GitResult the caller branches on, never the E channel; a total helper, not Effect-cosplay.
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

/**
 * How long a tree whose owner is a still-running LAUNCHER is held before the ordinary age/merge
 * gates decide it (#4001). The launcher stamp names the spawning pane, not the occupant, so its
 * liveness cannot be a permanent KEEP — but the harness's occupancy lock (checked first) is the
 * only occupant-keyed signal there is, and an occupant it failed to lock would be protected by
 * nothing else. This window is that backstop: two hours of *no file activity at all* — 4x the idle
 * threshold above, and well past the longest a live lane plausibly goes without touching its tree
 * (a shipper polling CI through `gh api` is the worst case, and it is bounded by the run itself) —
 * so it only ever releases a tree whose occupant has long since finished.
 */
const LAUNCHER_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * Newest mtime (ms) among the given paths, or `null` when none can be stat'd. Each stat goes
 * through the `FileSystem` seam and degrades to "skipped" on a fault, so an absent/unreadable
 * path is still passed over and a wholly unresolvable set still falls to the `null` fail-safe.
 * `Option.none()` mtime (a stat with no timestamp) counts as unresolvable, same as a fault.
 */
const newestMtimeMs = (
	paths: ReadonlyArray<string>,
): Effect.Effect<number | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		let newest: number | null = null;
		for (const p of paths) {
			const mtime = yield* fs.stat(p).pipe(
				Effect.map((info) => info.mtime.pipe(Option.map((d) => d.getTime()))),
				Effect.orElseSucceed(() => Option.none<number>()),
			);
			if (Option.isNone(mtime)) continue;
			if (newest === null || mtime.value > newest) newest = mtime.value;
		}
		return newest;
	});

/**
 * How long a managed worktree has gone untouched, as the two idle facts the classifier reads
 * (#2240, #4001). Probes the worktree dir + its per-tree `HEAD` and `logs/HEAD` — a commit/checkout
 * bumps HEAD and appends the reflog, a new file bumps the dir; a still-editing lane is caught
 * earlier as `dirty`. The index is deliberately NOT probed: `git status` (the dirty check) can
 * rewrite it, which would mask idleness. Both facts derive from ONE mtime read so they can never
 * disagree about the same tree, and any unresolvable mtime ⇒ presumed active AND within grace
 * (fail-safe KEEP on both).
 */
const worktreeIdleFacts = (
	path: string,
): Effect.Effect<
	{recentlyActive: boolean; idleBeyondLauncherGrace: boolean},
	never,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const pathSvc = yield* Path.Path;
		const gitdir = runGit(["-C", path, "rev-parse", "--absolute-git-dir"]);
		const probes = [path];
		if (gitdir.ok) {
			const g = gitdir.stdout.trim();
			probes.push(pathSvc.join(g, "HEAD"), pathSvc.join(g, "logs", "HEAD"));
		}
		const newest = yield* newestMtimeMs(probes);
		if (newest === null) return {recentlyActive: true, idleBeyondLauncherGrace: false};
		const idleFor = Date.now() - newest;
		return {
			recentlyActive: idleFor < IDLE_THRESHOLD_MS,
			idleBeyondLauncherGrace: idleFor >= LAUNCHER_GRACE_MS,
		};
	});

/**
 * The harness's live-session registry directory — one `<pid>.json` per RUNNING session, deleted
 * when the session exits. `$CLAUDE_CONFIG_DIR` is the harness's own override for the config root;
 * absent it, the tool's default config home under the user's home dir.
 */
const sessionRegistryDir = (path: Path.Path): string =>
	path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude"), "sessions");

/**
 * Is `pid` running? Fails toward TRUE, which is what keeps a tree: `ESRCH` is the only positive
 * evidence of absence, `EPERM` proves the process EXISTS under another uid, and any other error
 * means the probe could not execute — never that the process is gone (#3943, and the #787 class
 * where a stripped exec env made a probe's own failure look like a signal).
 */
const pidIsAlive = (pid: number): boolean => {
	// biome-ignore lint/plugin: signal-0 presence probe — `process.kill` throws to report absence, so the branch IS the result; a total helper, never E.
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return (cause as {code?: string}).code !== "ESRCH";
	}
};

/**
 * The set of session ids proven alive, or `null` when the registry can't be trusted — in which
 * case every worktree's owner resolves `"unknown"` and nothing is removed (`liveSessionIds`).
 */
const probeLiveSessions = (): Effect.Effect<
	ReadonlySet<string> | null,
	never,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathSvc = yield* Path.Path;
		const dir = sessionRegistryDir(pathSvc);
		const names = yield* fs
			.readDirectory(dir)
			.pipe(Effect.orElseSucceed((): ReadonlyArray<string> | null => null));
		if (names === null) return liveSessionIds({readable: false, entries: []});
		const entries: Array<{sessionId: string; alive: boolean}> = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const raw = yield* fs
				.readFileString(pathSvc.join(dir, name), "utf8")
				.pipe(Effect.orElseSucceed((): string | null => null));
			if (raw === null) continue;
			const entry = parseSessionRegistryEntry(raw);
			if (entry === null) continue;
			entries.push({sessionId: entry.sessionId, alive: pidIsAlive(entry.pid)});
		}
		return liveSessionIds({readable: true, entries});
	});

/** The stamp `hooks/create-worktree.sh` writes into `<gitdir>/`; the two names must stay in sync. */
const OWNER_STAMP_FILE = "kampus-owner.json";

/**
 * The session that OWNS this worktree: the `WorktreeCreate` stamp in its git admin dir
 * (`hooks/create-worktree.sh`), else a bare session-UUID segment in its own path — the fallback for
 * a `$TMPDIR`-rooted review-head tree, which no hook provisions. `null` when neither resolves, so
 * an unstamped tree is never judged dead. The path fallback is a `"launcher"` identity: the UUID
 * roots the spawning pane's scratchpad, not the review subagent inside it (#4001).
 */
const ownerOf = (
	worktreePath: string,
): Effect.Effect<OwnerStamp | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const gitdir = runGit(["-C", worktreePath, "rev-parse", "--absolute-git-dir"]);
		if (gitdir.ok) {
			const fs = yield* FileSystem.FileSystem;
			const pathSvc = yield* Path.Path;
			const raw = yield* fs
				.readFileString(pathSvc.join(gitdir.stdout.trim(), OWNER_STAMP_FILE), "utf8")
				.pipe(Effect.orElseSucceed((): string | null => null));
			const stamped = raw === null ? null : parseOwnerStamp(raw);
			if (stamped !== null) return stamped;
		}
		const fromPath = sessionIdFromPath(worktreePath);
		return fromPath === null ? null : {sessionId: fromPath, kind: "launcher"};
	});

const runGh = (args: ReadonlyArray<string>): GitResult => {
	// biome-ignore lint/plugin: best-effort gh shell — a non-zero exit is fully absorbed into a {ok:false} GitResult the caller branches on, never the E channel; a total helper, not Effect-cosplay.
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
		// Probed ONCE per run: the registry is a property of the machine, not of a worktree, and a
		// per-tree re-read could observe a session exit mid-sweep and split one run's verdicts
		// across two different truths.
		const live = yield* probeLiveSessions();
		// Sequential (concurrency 1) on purpose: the liveness probe now crosses the `FileSystem`
		// seam, and the per-worktree git shell-outs must stay in the same order as before.
		const records: ReadonlyArray<WorktreeRecord> = yield* Effect.forEach(
			parsed.filter((p) => !p.bare),
			(p) =>
				Effect.gen(function* () {
					// A gone-dir tree's working directory is missing, so every probe below is either
					// meaningless or actively errors (`git -C <gone> status` fails → fail-safe dirty,
					// which would mis-KEEP it). Short-circuit to the safe-to-prune record: the classifier
					// checks `prunable` first, so the other facts are never consulted for it (#3654).
					if (p.prunable) {
						return {
							path: p.path,
							branch: p.branch,
							prunable: true,
							isDirty: false,
							reachableFromOriginMain: false,
							squashMergedToOriginMain: false,
							locked: p.locked,
							recentlyActive: false,
							hasOpenPr: false,
							// Moot for a gone-dir tree — `prunable` short-circuits the classifier before any
							// liveness gate, and a prune only clears admin metadata for a tree that is already
							// gone from disk, so there is no live working surface to pull out from under an owner.
							ownerLiveness: "unknown" as OwnerLiveness,
							idleBeyondLauncherGrace: false,
						};
					}
					const managed = isManagedWorktree(p.path);
					// A review-head tree is a swept candidate too (#2785), so its liveness (idle mtime)
					// must be probed. Its detached HEAD carries no branch, so the open-PR probe below
					// (branch-keyed) is N/A for it — the dirty/locked/idle triple carries its liveness.
					const swept = managed || isReviewHeadWorktree(p.path);
					const isDirty = worktreeIsDirty(p.path);
					const reachable = reachableFromOriginMain(p.head);
					// Only probe the costlier squash signal when ancestry already missed.
					const squashMerged = reachable ? false : squashMergedToOriginMain(p.head);
					const {recentlyActive, idleBeyondLauncherGrace} = swept
						? yield* worktreeIdleFacts(p.path)
						: {recentlyActive: false, idleBeyondLauncherGrace: false};
					// Presence beats recency (#3943): a live shipper lane is mtime-idle, so `recentlyActive`
					// cannot see it. Probed only for a swept tree — an unswept one is already KEEP.
					const ownerLiveness: OwnerLiveness = swept
						? resolveOwnerLiveness({owner: yield* ownerOf(p.path), liveSessionIds: live})
						: "unknown";
					// Mirrors the classifier's owner gates so the probe below fires for exactly the trees
					// that can reach the open-PR branch — including a launcher-owned one past its grace
					// window (#4001), which would otherwise skip the probe and be reaped with a PR open.
					const ownerPermitsRemoval =
						ownerLiveness === "dead" ||
						(ownerLiveness === "launcher-alive" && idleBeyondLauncherGrace);
					// The network open-PR probe fires ONLY for a BUILD tree that would otherwise be swept —
					// managed, clean, unlocked, idle, and content-merged — so SessionStart makes at most
					// one gh call per reap candidate (usually zero), never one per worktree. A review-head
					// tree never enters here (no branch, and its classifier branch precedes the open-PR gate).
					const wouldRemove =
						managed &&
						!isDirty &&
						!p.locked &&
						ownerPermitsRemoval &&
						!recentlyActive &&
						(reachable || squashMerged);
					const hasOpenPr = wouldRemove ? branchHasOpenPr(p.branch) : false;
					return {
						path: p.path,
						branch: p.branch,
						prunable: false,
						isDirty,
						reachableFromOriginMain: reachable,
						squashMergedToOriginMain: squashMerged,
						locked: p.locked,
						recentlyActive,
						hasOpenPr,
						ownerLiveness,
						idleBeyondLauncherGrace,
					};
				}),
			{concurrency: 1},
		);

		const plan = computeWorktreeSweepPlan(records);

		// ADR 0092 "emit what you scanned": the full plan is observable before any action —
		// including WHICH presence truth the run resolved, so an all-KEEP sweep reads as a
		// fail-closed registry rather than as a silent no-op.
		yield* Console.log(
			live === null
				? "worktree-sweep: session registry UNRESOLVED — every swept tree KEPT as owner-unknown (fail-closed, #3943)"
				: `worktree-sweep: ${live.size} live session(s) in the registry — owner presence decides removal (ADR 0191)`,
		);
		yield* Console.log(
			`worktree-sweep: ${records.length} worktree(s) scanned — ${plan.toRemove.length} removable, ${plan.kept.length} kept${execute ? " (EXECUTE)" : " (dry-run)"}`,
		);
		if (plan.kept.length > 0) {
			// The per-reason tally is what makes a near-silent run diagnosable at a glance (#4001):
			// a wall of `live-session` means real occupants, a wall of `launcher-alive` means one
			// long-lived pane's spawn history, and a wall of `owner-unknown` means an unresolved
			// registry — three very different causes the bare "N kept" collapsed into one number.
			const tally = new Map<string, number>();
			for (const k of plan.kept) tally.set(k.reason, (tally.get(k.reason) ?? 0) + 1);
			yield* Console.log(
				`kept by reason: ${[...tally].map(([reason, n]) => `${reason}=${n}`).join(" ")}`,
			);
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

		// A gone-dir tree has no path to `git worktree remove`; a single `git worktree prune` reaps
		// ALL prunable admin metadata at once, and every gone-dir record maps to exactly what prune
		// clears (both keyed on the same `prunable` fact), so the plan and the prune stay consistent.
		const goneDir = plan.toRemove.filter((r) => r.reason === "gone-dir");
		const toRemovePaths = plan.toRemove.filter((r) => r.reason !== "gone-dir");

		let pruned = 0;
		if (goneDir.length > 0) {
			const res = runGit(["worktree", "prune", "--verbose"]);
			if (res.ok) {
				pruned = goneDir.length;
				for (const r of goneDir)
					yield* Console.log(`  pruned (gone-dir metadata) ${r.worktree.path}`);
			} else {
				yield* Console.error(`  gone-dir prune failed — ${res.stderr.trim()}`);
			}
		}

		let removed = 0;
		let refused = 0;
		for (const r of toRemovePaths) {
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
			`worktree-sweep: removed ${removed}, pruned ${pruned}, kept ${plan.kept.length + refused}` +
				(refused > 0 ? ` (${refused} removable but refused by git → kept)` : ""),
		);
	}),
).pipe(
	Command.withDescription(
		"Safe bulk drain of accumulated agent build worktrees + leaked review-head checkouts + gone-dir metadata — clean+idle only, never --force (#1243/#2785/#3654)",
	),
);

export const worktreeSweepCommand = worktreeSweep;
