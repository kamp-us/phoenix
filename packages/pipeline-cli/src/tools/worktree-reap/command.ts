/**
 * The `worktree-reap` tool — `pipeline-cli worktree-reap [--execute]`.
 *
 * A safe reaper for agent worktrees orphaned by DEAD agent sessions (issue #3754). Dead
 * sessions leave their `isolation:worktree` trees (and checked-out branches) behind under
 * `.claude/worktrees/`, where they accumulate and block their branches from being
 * re-checked-out elsewhere. This verb identifies trees whose owning SESSION is provably
 * dead, and reclaims only the ones that hold nothing recoverable. The `$TMPDIR`-rooted
 * `review-head-*` review checkouts are in scope too, since they now carry the same pid-bearing
 * agent lock (#4004) — see `worktree-reap.ts` for what that changes for them.
 *
 * Eligibility is session-presence-based, never age-based (ADR 0191), read from two owner
 * signals gathered here and folded by the pure classifier:
 *
 *   1. the git lock reason — `claude agent <id> (pid <N> start <date>)`, its pid probed with
 *      `process.kill(pid, 0)` (ESRCH is the only proof of death);
 *   2. the `kampus-owner.json` stamp `hooks/create-worktree.sh` writes into the tree's git
 *      admin dir, resolved against the harness live-session registry through
 *      `worktree-sweep`'s `owner-liveness.ts` — the shared resolution, not a second one (#3989).
 *
 * Signal 2 is what makes the verb effective at all: only a minority of managed trees carry a
 * lock at any moment, so a lock-only gate spared essentially the whole population as
 * `owner-unknown` (#3989). This is the deliberate contrast with the age-based `worktree-sweep`
 * (mtime-idle, #2240): a genuinely idle-but-live session is spared here because its process
 * still resolves.
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
 * Removing a tree does not delete the branch it was on — `git worktree remove` only un-checks-it-out
 * — so a reaped tree's ref is handed to the shared ref-reclaim pass (`../worktree-sweep/ref-reclaim.ts`),
 * which deletes it only on positive proof its content already lives on `origin/main` (#4190). That is a
 * STRICTER predicate than reaping the tree, and deliberately so: the tree is replaceable, the ref is the
 * only thing keeping unpushed commits reachable.
 *
 * DRY-RUN by default: with no flag it prints what it WOULD reap / keep-dirty / spare and
 * exits 0 without touching anything. The git IO uses `execFileSync` directly (mirrors
 * `worktree-sweep`), so the tool's requirement stays at the Node platform ceiling the
 * registry provides.
 */
import {execFileSync} from "node:child_process";
import {readdirSync, readFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {parseSessionRegistryEntry, sessionRegistryDir} from "../../session-registry.ts";
import {
	liveSessionIds,
	parseOwnerStamp,
	resolveOwnerLiveness,
} from "../worktree-sweep/owner-liveness.ts";
import {runRefReclaim} from "../worktree-sweep/ref-reclaim-io.ts";
import {isReviewHeadWorktree} from "../worktree-sweep/worktree-sweep.ts";
import {
	computeWorktreeReapPlan,
	isManagedAgentWorktree,
	type OwnerPresence,
	ownerPresence,
	parseAgentLockOwner,
	parseWorktreeList,
	presenceFromOwnerLiveness,
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
		// Capture stderr instead of letting it inherit: over a few hundred worktrees, a tree whose
		// directory is already gone makes git print `fatal: cannot change to …` for every probe, which
		// would bury the plan this verb exists to show. The failure is not lost — it lands in the
		// GitResult the caller branches on, and each probe already fails safe toward KEEP.
		const stdout = execFileSync("git", [...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
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

/** This verb's `node:path` binding of the shared registry-location rule (`session-registry.ts`). */
const registryDir = (): string =>
	sessionRegistryDir({configDir: process.env.CLAUDE_CONFIG_DIR, home: homedir(), join});

/** Read a file, or `null` on ANY failure — an unreadable input is never evidence about a session. */
const readTextOrNull = (path: string): string | null => {
	// biome-ignore lint/plugin: best-effort read — every failure mode (absent, unreadable, a race with the tree's removal) collapses into the same `null` the caller branches on, never the E channel. A total helper, not Effect-cosplay.
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};

/**
 * The set of session ids proven alive, or `null` when the registry can't be trusted to be complete
 * — in which case every stamp resolves `"unknown"` and signal 2 spares everything. The trust rule
 * (including the load-bearing "zero live entries means the registry is broken, not that nothing is
 * running") lives in `liveSessionIds`; this is only its IO.
 */
const probeLiveSessions = (): ReadonlySet<string> | null => {
	const dir = registryDir();
	let names: ReadonlyArray<string>;
	// biome-ignore lint/plugin: best-effort enumeration — an unreadable registry dir is reported as `readable: false`, the fail-closed input `liveSessionIds` turns into "trust nothing", never the E channel.
	try {
		names = readdirSync(dir);
	} catch {
		return liveSessionIds({readable: false, entries: []});
	}
	const entries: Array<{sessionId: string; alive: boolean}> = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const raw = readTextOrNull(join(dir, name));
		if (raw === null) continue;
		const entry = parseSessionRegistryEntry(raw);
		if (entry === null) continue;
		entries.push({sessionId: entry.sessionId, alive: pidAlive(entry.pid)});
	}
	return liveSessionIds({readable: true, entries});
};

/** The stamp `hooks/create-worktree.sh` writes into `<gitdir>/`; the two names must stay in sync. */
const OWNER_STAMP_FILE = "kampus-owner.json";

/**
 * Signal 2 for one tree: its owner stamp resolved against the live-session registry. Unlike the
 * sweep, this takes NO session-id-from-path fallback — that fallback guesses an owner from a
 * `$TMPDIR` path, and a review-head tree is not called here at all (#4004): it carries its own
 * `review-head materialize` lock, which is signal 1 and a far better fact than a path guess. An
 * unresolvable gitdir, an absent stamp, a malformed stamp, or an untrusted registry all
 * read `"unknown"` (⇒ the tree is spared unless the lock signal independently proves death).
 */
const stampPresenceOf = (worktreePath: string, live: ReadonlySet<string> | null): OwnerPresence => {
	const gitdir = runGit(["-C", worktreePath, "rev-parse", "--absolute-git-dir"]);
	const raw = gitdir.ok ? readTextOrNull(join(gitdir.stdout.trim(), OWNER_STAMP_FILE)) : null;
	const owner = raw === null ? null : parseOwnerStamp(raw);
	return presenceFromOwnerLiveness(resolveOwnerLiveness({owner, liveSessionIds: live}));
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

/** Which signal(s) proved this tree's owner dead — so a reap line says WHY, not just that it will. */
const deadOwnerLabel = (c: ReapCandidate): string => {
	const lock = c.lockOwner === null ? null : `lock pid ${c.lockOwner.pid} dead`;
	const stamp = c.stampPresence === "dead" ? "stamped session dead" : null;
	return [lock, stamp].filter((s) => s !== null).join(" + ") || "owner dead";
};

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

		// Probed ONCE for the whole run, not per tree: it is a directory read plus one pid probe per
		// running session, and a per-tree re-read would also let the answer drift mid-scan.
		const live = probeLiveSessions();

		const parsed = parseWorktreeList(listed.stdout);
		const candidates: ReadonlyArray<ReapCandidate> = parsed
			.filter((p) => !p.bare)
			.map((p) => {
				// The primary checkout and any foreign tree short-circuit to a SPARE record — the
				// classifier never consults the other fields for them, so no stamp read, pid probe,
				// `git status`, or ancestry walk ever fires outside the two in-scope classes.
				const reviewHead = isReviewHeadWorktree(p.path);
				if (!isManagedAgentWorktree(p.path) && !reviewHead) {
					return {
						path: p.path,
						branch: p.branch,
						lockOwner: null,
						foreignLock: false,
						stampPresence: "unknown" as const,
						hasUncommitted: false,
						hasUnpushed: false,
					};
				}
				const parsedLock = parseAgentLockOwner(p.lockReason);
				const foreignLock = parsedLock === null && p.lockReason !== null;
				const facts = {
					path: p.path,
					branch: p.branch,
					lockOwner:
						parsedLock === null ? null : {pid: parsedLock.pid, alive: pidAlive(parsedLock.pid)},
					foreignLock,
					// An operator-pinned tree is spared whatever its owner says, so don't read its stamp —
					// nor is there one to read for a `$TMPDIR`-rooted review-head tree, which no hook
					// provisions: signal 1, its own `review-head materialize` lock, is all it ever carries.
					stampPresence:
						foreignLock || reviewHead ? ("unknown" as const) : stampPresenceOf(p.path, live),
				};
				// Only a tree whose owner is PROVEN dead needs its recoverable-work facts gathered; a
				// live or unprovable owner is spared before those checks are ever consulted, so the
				// costlier status/ancestry probes are skipped for it. Gating on the classifier's own
				// `ownerPresence` keeps that decision in one place instead of re-deriving it here.
				if (ownerPresence(facts) !== "dead") {
					return {...facts, hasUncommitted: false, hasUnpushed: false};
				}
				return {
					...facts,
					hasUncommitted: worktreeHasUncommitted(p.path),
					// The ancestry probe is meaningless for a review-head tree — its detached head came
					// off the remote, so the classifier does not consult this fact for it (#4004).
					hasUnpushed: reviewHead ? false : hasUnpushed(p.head),
				};
			});

		const plan = computeWorktreeReapPlan(candidates);

		// ADR 0092 "emit what you scanned": the full plan is observable before any action, and so is
		// the registry's trust state — an untrusted registry silently disables signal 2 entirely, so
		// it must be readable in the output rather than inferred from a wall of `owner-unknown`.
		yield* Console.log(
			`worktree-reap: ${candidates.length} worktree(s) scanned — ${plan.toReap.length} orphaned-clean (reapable), ${plan.keptDirty.length} kept-dirty, ${plan.spared.length} spared${execute ? " (EXECUTE)" : " (dry-run)"}`,
		);
		yield* Console.log(
			live === null
				? "  session registry: UNTRUSTED (absent/unreadable/no live entry) — owner stamps prove nothing this run"
				: `  session registry: ${live.size} live session(s) — owner stamps resolved against it`,
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
				yield* Console.log(reasonLine(r.worktree.path, deadOwnerLabel(r.worktree)));
		}

		// The branches the reapable trees sit on. Each is re-decided by the ref predicate on its own
		// (#4190) — reaping a tree does not by itself make its ref safe to drop.
		const branchesOfReapable = plan.toReap.flatMap((r) =>
			r.worktree.branch === null ? [] : [r.worktree.branch],
		);

		if (!execute) {
			yield* Console.log("  (dry-run — pass --execute to reap; nothing touched)");
			yield* runRefReclaim({
				label: "worktree-reap refs",
				scope: {kind: "named", names: branchesOfReapable},
				execute: false,
			});
			return;
		}

		let reaped = 0;
		let refused = 0;
		const reclaimableBranches: Array<string> = [];
		for (const r of plan.toReap) {
			const path = r.worktree.path;
			// If the tree still holds a lock it is OUR OWN stale pid-lock (its session is proven dead,
			// and an operator's foreign lock was spared before reaching here). Unlock it — scoped to
			// this classified-dead+clean tree — so the non-forced remove can proceed. Most reapable
			// trees are simply unlocked, which reports "not locked" and is absorbed below.
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
				if (r.worktree.branch !== null) reclaimableBranches.push(r.worktree.branch);
				// "checked out nowhere", NOT "deleted": `git worktree remove` never deletes a branch. The
				// old wording claimed a reclaim that had not happened, which is plausibly why six weeks of
				// ref growth went unnoticed (#4190). The ref pass below is what may actually delete it.
				yield* Console.log(
					`  reaped ${path}${r.worktree.branch !== null ? ` (branch ${r.worktree.branch} no longer checked out)` : ""}`,
				);
			} else {
				refused += 1;
				yield* Console.error(
					`  KEPT (git refused, never --force) ${path} — ${removed.stderr.trim()}`,
				);
			}
		}
		// After the removals, so a just-freed ref is no longer checked out by a registered worktree.
		const refs = yield* runRefReclaim({
			label: "worktree-reap refs",
			scope: {kind: "named", names: reclaimableBranches},
			execute: true,
		});
		yield* Console.log(
			`worktree-reap: reaped ${reaped}, refs deleted ${refs.deleted}, kept ${plan.keptDirty.length + refused}, spared ${plan.spared.length}` +
				(refused > 0 ? ` (${refused} reapable but refused by git → kept)` : ""),
		);
	}),
).pipe(
	Command.withDescription(
		"Safe reaper for agent worktrees orphaned by DEAD agent sessions — session-presence-based (ADR 0191), clean+pushed only, never --force (#3754)",
	),
);

export const worktreeReapCommand = worktreeReap;
