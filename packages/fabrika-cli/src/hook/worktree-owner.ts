/**
 * The one place `hook worktree-create` creates a worktree: every base fetch and every
 * `git worktree add` the hook runs goes through {@link createWorktree}.
 *
 * The order is the design:
 *
 *  1. Read the clone's common git dir and its default branch — reads, outside the lock.
 *  2. Take the repo-level creation lock (`creation-lock.ts`).
 *  3. Fetch the base into a per-spawn ref, resolve it to a commit, drop the ref, and
 *     `git worktree add --detach` at that commit **with hooks off**.
 *  4. Release the lock — on every exit path.
 *  5. Run the dependency install, **outside** the lock, so the installs of concurrent spawns overlap.
 *  6. Refuse unless the tree exists and its virtual store landed.
 *
 * The lock is what stops parallel spawns racing each other inside the hook. It holds only the fetch
 * and the add, which is what makes it affordable: the ~10s install that used to ride on
 * `post-checkout` inside the add now runs after the release.
 * @ruling https://github.com/kamp-us/phoenix/issues/7057
 *
 * Every failure arm refuses, and a refusal blocks the spawn: the harness reads any non-zero exit as a
 * creation failure and does not fall back to git, so a blocked spawn is the only honest alternative
 * to handing an agent a tree this owner could not finish.
 */
import {Effect, FileSystem, Option} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type ChildOutcome, execRecord} from "../io/exec.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	BASE_FETCH_FAILED,
	CREATION_LOCK_UNAVAILABLE,
	DEPS_NOT_PROVISIONED,
	WORKTREE_ADD_FAILED,
} from "./codes.ts";
import {
	type Holder,
	type LockHost,
	lockDirFor,
	WAIT_BUDGET_MS,
	withCreationLock,
} from "./creation-lock.ts";
import {
	addWorktreeArgs,
	baseRefFor,
	CONCURRENCY_ARM_CAUSE,
	type ConcurrencyArm,
	commonDirArgs,
	concurrencyArm,
	dropBaseRefArgs,
	fetchBaseArgs,
	installArgs,
	isCommitId,
	pruneWorktreesArgs,
	RECOVERY_ATTEMPTS,
	recoveryBackoffMs,
	resolveBaseArgs,
	type WorktreePlan,
} from "./worktree-create.ts";

const VERB = "fabrika hook worktree-create";

/** The hook's own budget is 600s; each child gets most of it, so a slow install is not a timeout. */
export const GIT_TIMEOUT_SECONDS = 540;
export const CAPTURE_BYTES = 64 * 1024;

/** The proof deps landed. The install writes the virtual store; a clean SKIP writes nothing. */
const VIRTUAL_STORE = "node_modules/.pnpm";

export type Requirements = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem;

/** The child's diagnostics, trimmed to one quotable line for the refusal that names them. */
export const firstLine = (bytes: Uint8Array): string => {
	const text = new TextDecoder().decode(bytes);
	return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
};

export const describeOutcome = (outcome: ChildOutcome): string => {
	if (outcome._tag === "Unstartable") return `could not run git — ${outcome.reason}`;
	if (outcome.timedOut) return `git did not finish within ${GIT_TIMEOUT_SECONDS}s`;
	return firstLine(outcome.stderr) || `git exited ${outcome.exitCode}`;
};

export const succeeded = (outcome: ChildOutcome): boolean =>
	outcome._tag === "Ran" && !outcome.timedOut && outcome.exitCode === 0;

/**
 * A command's whole stderr, for classification — not {@link describeOutcome}'s one quotable line.
 *
 * git prints the connectivity-check failure across two lines, and which line is first is not
 * something this owner should depend on. An unstartable git carries no git diagnostic at all, so it
 * classifies as nothing and refuses at once, which is right: a missing binary is not transient.
 *
 * A timed-out run classifies as nothing for the same reason, and it is the arm that pays worst for
 * getting this wrong: one timed-out command spends {@link GIT_TIMEOUT_SECONDS} of the hook's 600s
 * budget, so a second attempt cannot finish inside what is left and the hook is killed partway
 * through it, losing the refusal it would have emitted at once. Whatever stderr it captured
 * before the clock ran out, a command that never exited is not evidence of a transient sibling
 * window. {@link describeOutcome} renders it as the timeout it was.
 */
const diagnostics = (outcome: ChildOutcome): string =>
	outcome._tag === "Ran" && !outcome.timedOut ? new TextDecoder().decode(outcome.stderr) : "";

export const git = (
	args: ReadonlyArray<string>,
	cwd: string,
	env: Record<string, string>,
): Effect.Effect<ChildOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	execRecord({
		file: "git",
		args,
		cwd,
		env,
		timeoutSeconds: GIT_TIMEOUT_SECONDS,
		captureBytes: CAPTURE_BYTES,
	});

const stdoutOf = (outcome: ChildOutcome): string =>
	outcome._tag === "Ran" ? new TextDecoder().decode(outcome.stdout).trim() : "";

export interface Attempted {
	readonly outcome: ChildOutcome;
	readonly attempts: number;
	/** Non-null only when every attempt lost to that arm — the recovery ran out, not a pass. */
	readonly exhausted: ConcurrencyArm | null;
}

/**
 * Run one git command, recovering only while it keeps losing to a named sibling-add arm.
 *
 * Each recovery round is a prune then a wait, which is the pair the two sources need: the prune
 * clears a dead sibling's leftover administrative directory, which no amount of waiting clears, and
 * the wait outlasts a live sibling's creation window, which no prune may touch. The prune's own
 * status is not read — it is a clear-and-retry, and if it changed nothing the next attempt fails the
 * same way and the refusal carries git's own diagnostic.
 *
 * Any diagnostic {@link concurrencyArm} does not recognise returns on the first attempt, so a genuine
 * failure is never delayed and never retried into looking like one of these.
 *
 * Exported for the unit test beside this file: the command is already this function's parameter, so
 * a test hands it an outcome the spawner cannot express — a timed-out run — and counts the attempts.
 */
export const withConcurrencyRecovery = (
	command: Effect.Effect<ChildOutcome, never, ChildProcessSpawner.ChildProcessSpawner>,
	repoRoot: string,
	env: Record<string, string>,
): Effect.Effect<Attempted, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		let outcome = yield* command;
		let arm = succeeded(outcome) ? null : concurrencyArm(diagnostics(outcome));
		let attempts = 1;
		while (arm !== null && attempts < RECOVERY_ATTEMPTS) {
			yield* git(pruneWorktreesArgs, repoRoot, env);
			yield* Effect.sleep(`${recoveryBackoffMs(attempts)} millis`);
			outcome = yield* command;
			attempts += 1;
			arm = succeeded(outcome) ? null : concurrencyArm(diagnostics(outcome));
		}
		return {outcome, attempts, exhausted: arm};
	});

/** What the recovery spent, for the refusal line — empty when there was nothing to recover from. */
const spent = (attempted: Attempted): string =>
	attempted.exhausted === null
		? ""
		: ` after ${attempted.attempts} attempts against ${CONCURRENCY_ARM_CAUSE[attempted.exhausted]}`;

/**
 * The branch `origin`'s HEAD points at, or `main`.
 *
 * Read rather than hardcoded so a repo whose default branch is not `main` provisions instead of
 * refusing on every spawn — but the fallback is a plain default, not a guess dressed as a read: an
 * unresolvable `origin/HEAD` is the ordinary state of a fresh clone, and the fetch below is what
 * turns a wrong answer into a loud one.
 */
const baseBranch = (
	repoRoot: string,
	env: Record<string, string>,
): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
	git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoRoot, env).pipe(
		Effect.map((outcome) => {
			if (!succeeded(outcome)) return "main";
			const ref = stdoutOf(outcome);
			const slash = ref.indexOf("/");
			return slash > 0 ? ref.slice(slash + 1) : "main";
		}),
	);

/** What the locked section produced: a tree at a commit, or the refusal that stopped it. */
type Added =
	| {readonly _tag: "Added"; readonly commit: string}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * The fetch and the add — the only commands the creation lock holds.
 *
 * The fetch is not a courtesy. The primary checkout's `origin/main` only advances on an explicit
 * fetch and nothing fetches per spawn, so branching off the cached tip bases a lane on state missing
 * a sibling lane's just-merged commit — two lanes then both go green in isolation and collide at
 * ship time, or one silently reverts the other. So the base is what *this* fetch just
 * wrote, never a remote-tracking ref somebody else's fetch maintains, and the fetch still never
 * moves the primary's local `main`.
 *
 * What it is not is `FETCH_HEAD`. That name is shared by every spawn of this clone, so the base
 * travelled through a file a sibling's fetch could truncate mid-read. It lands in a per-spawn ref
 * instead, is resolved to a commit id, and the ref is dropped before the add — so nothing this owner
 * branches from has a name another process can write.
 *
 * Both commands keep the bounded prune-and-retry recovery; `ConcurrencyArm` says why the lock does
 * not retire it.
 */
const fetchAndAdd = (
	plan: WorktreePlan,
	env: Record<string, string>,
	base: string,
	baseRef: string,
): Effect.Effect<Added, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const fetched = yield* withConcurrencyRecovery(
			git(fetchBaseArgs(base, baseRef), plan.repoRoot, env),
			plan.repoRoot,
			env,
		);
		if (!succeeded(fetched.outcome)) {
			return {
				_tag: "Refused",
				outcome: refuse(
					BASE_FETCH_FAILED,
					`${VERB}: could not fetch origin/${base}${spent(fetched)} — refusing to branch from a possibly stale base: ${describeOutcome(fetched.outcome)}`,
				),
			};
		}

		const resolved = yield* git(resolveBaseArgs(baseRef), plan.repoRoot, env);
		const commit = stdoutOf(resolved);
		// Dropped whatever the resolve said, and before the refusal below, so a spawn that fails here
		// leaves no ref behind; `git worktree add` needs only the id, which is already in hand.
		yield* git(dropBaseRefArgs(baseRef), plan.repoRoot, env);
		if (!succeeded(resolved) || !isCommitId(commit)) {
			return {
				_tag: "Refused",
				outcome: refuse(
					BASE_FETCH_FAILED,
					`${VERB}: fetched origin/${base} and ${baseRef} named no commit — refusing to branch from a base this verb cannot prove: ${describeOutcome(resolved)}`,
				),
			};
		}

		const added = yield* withConcurrencyRecovery(
			git(addWorktreeArgs(plan.worktreePath, commit), plan.repoRoot, env),
			plan.repoRoot,
			env,
		);
		if (!succeeded(added.outcome)) {
			return {
				_tag: "Refused",
				outcome: refuse(
					WORKTREE_ADD_FAILED,
					`${VERB}: git worktree add --detach ${plan.worktreePath} ${commit} failed${spent(added)}: ${describeOutcome(added.outcome)}`,
				),
			};
		}
		return {_tag: "Added", commit};
	});

const describeHolder = (holder: Option.Option<Holder>): string =>
	Option.match(holder, {
		onNone: () => "a holder whose stamp could not be read",
		onSome: (read) =>
			`pid ${read.pid} on ${read.host}, holding since ${new Date(read.at).toISOString()}`,
	});

/**
 * Create the tree the plan names and install its deps, or refuse with the arm that failed.
 *
 * `host` is this process's identity for the lock — injected so a test can state which pids are
 * alive — and `waitBudgetMs` how long to wait on a live holder before refusing.
 */
export const createWorktree = (
	plan: WorktreePlan,
	env: Record<string, string>,
	nonce: string,
	host: LockHost,
	waitBudgetMs: number = WAIT_BUDGET_MS,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		const common = yield* git(commonDirArgs, plan.repoRoot, env);
		const commonDir = stdoutOf(common);
		if (!succeeded(common) || !commonDir.startsWith("/")) {
			return refuse(
				CREATION_LOCK_UNAVAILABLE,
				`${VERB}: could not read the common git dir of ${plan.repoRoot}, where the creation lock lives: ${describeOutcome(common)}`,
			);
		}
		const lockDir = lockDirFor(commonDir);
		const base = yield* baseBranch(plan.repoRoot, env);

		const locked = yield* withCreationLock(
			fs,
			lockDir,
			host,
			fetchAndAdd(plan, env, base, baseRefFor(plan.name, nonce)),
			{
				onBusy: (holder): Added => ({
					_tag: "Refused",
					outcome: refuse(
						CREATION_LOCK_UNAVAILABLE,
						`${VERB}: ${lockDir} is still held by ${describeHolder(holder)} — nothing was fetched or added; re-run once that spawn finishes`,
					),
				}),
				onUnplaceable: (reason): Added => ({
					_tag: "Refused",
					outcome: refuse(
						CREATION_LOCK_UNAVAILABLE,
						`${VERB}: the creation lock could not be taken — ${reason}`,
					),
				}),
			},
			waitBudgetMs,
		);
		if (locked._tag === "Refused") return locked.outcome;

		// A recovered add reports the status of its last attempt only, so the tree it claims to have
		// built is checked as an artifact before the deps under it are — a `git worktree add` that
		// exits 0 over a window this owner just retried through must not be adopted on its word.
		const created = yield* fs.exists(plan.worktreePath).pipe(Effect.orElseSucceed(() => false));
		if (!created) {
			return refuse(
				WORKTREE_ADD_FAILED,
				`${VERB}: git worktree add exited 0 and ${plan.worktreePath} does not exist — refusing to emit a path to no tree`,
			);
		}

		const installed = yield* git(installArgs(locked.commit), plan.worktreePath, env);
		const provisioned = yield* fs
			.exists(`${plan.worktreePath}/${VIRTUAL_STORE}`)
			.pipe(Effect.orElseSucceed(() => false));
		if (!provisioned) {
			return refuse(
				DEPS_NOT_PROVISIONED,
				`${VERB}: ${plan.worktreePath} has no ${VIRTUAL_STORE} — the post-checkout install skipped or failed, so the tree would arrive dep-less`,
				[
					`${VERB}: the install ${succeeded(installed) ? "exited 0" : `failed: ${describeOutcome(installed)}`}`,
					`${VERB}: remove the half-built tree with \`git worktree remove ${plan.worktreePath}\``,
				],
			);
		}

		return answer(plan.worktreePath, [
			`${VERB}: provisioned ${plan.worktreePath} at origin/${base}`,
		]);
	});
