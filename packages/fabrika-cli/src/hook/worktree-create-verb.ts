/**
 * `hook worktree-create` — the provider verb behind phoenix's `WorktreeCreate` hook.
 *
 * It exists because the harness's own worktree path leaves the tree **dep-less**. That path execs
 * git hooks with a stripped `PATH`, so lefthook's `post-checkout` `bootstrap-deps` finds no
 * corepack, no pinned pnpm and no npm, and clean-SKIPs at exit 0 (ADR 0109 §3) — a silent skip that
 * is byte-identical, from the outside, to a successful install. Every `isolation: worktree` shell
 * then pays an install before its first verb, or fails at exit 126 on it (#7220).
 *
 * A `WorktreeCreate` hook **replaces** that path, and that is the whole mechanism: this verb runs
 * `git worktree add` itself, under a `PATH` that resolves the toolchain and a 600s hook budget, so
 * the same `bootstrap-deps` install ADR 0109 already owns actually runs. Nothing about *how* deps
 * are installed changes — only who triggers it and with what environment (ADR 0178, rehomed by ADR
 * 0337).
 *
 * **Every failure arm refuses, and a refusal blocks the spawn.** That is deliberate: the harness
 * reads any non-zero exit as a creation failure and does not fall back to git, so a blocked spawn is
 * the only honest alternative to handing an agent a tree this verb could not finish (ADR 0092). The
 * last arm is the one that makes the guarantee real — `git worktree add` succeeding proves nothing
 * about the install, so the deps are checked as an artifact before any path is emitted.
 */
import {randomUUID} from "node:crypto";
import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type ChildOutcome, execRecord} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	BASE_FETCH_FAILED,
	DEPS_NOT_PROVISIONED,
	EMPTY_STDIN,
	ENVELOPE_UNKNOWN,
	MALFORMED_ENVELOPE,
	UNPLANNABLE_WORKTREE,
	WORKTREE_ADD_FAILED,
	WRONG_EVENT,
} from "./codes.ts";
import {classifyEnvelope, type EnvelopeRead} from "./envelope.ts";
import {
	baseRefFor,
	CONCURRENCY_ARM_CAUSE,
	type ConcurrencyArm,
	childEnv,
	concurrencyArm,
	dropBaseRefArgs,
	fetchBaseArgs,
	isCommitId,
	planWorktree,
	pruneWorktreesArgs,
	RECOVERY_ATTEMPTS,
	recoveryBackoffMs,
	resolveBaseArgs,
	type WorktreePlan,
} from "./worktree-create.ts";

const VERB = "fabrika hook worktree-create";
const EVENT = "WorktreeCreate";

/** The hook's own budget is 600s; each child gets most of it, so a slow install is not a timeout. */
const GIT_TIMEOUT_SECONDS = 540;
const CAPTURE_BYTES = 64 * 1024;

/** The proof deps landed. `bootstrap-deps` writes the virtual store; a clean SKIP writes nothing. */
const VIRTUAL_STORE = "node_modules/.pnpm";

export interface WorktreeCreateOptions {
	readonly stdin: Effect.Effect<StdinRead>;
	/** Plan and report, mutate nothing. The declared hook can never pass it — rule 5 forbids flags. */
	readonly dryRun: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

type Requirements = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem;

const readEnvelope = (piped: StdinRead): EnvelopeRead =>
	piped._tag === "Text" ? classifyEnvelope(piped.text) : {_tag: "Unknown", reason: piped.reason};

/** The child's diagnostics, trimmed to one quotable line for the refusal that names them. */
const firstLine = (bytes: Uint8Array): string => {
	const text = new TextDecoder().decode(bytes);
	return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
};

const describe = (outcome: ChildOutcome): string => {
	if (outcome._tag === "Unstartable") return `could not run git — ${outcome.reason}`;
	if (outcome.timedOut) return `git did not finish within ${GIT_TIMEOUT_SECONDS}s`;
	return firstLine(outcome.stderr) || `git exited ${outcome.exitCode}`;
};

const succeeded = (outcome: ChildOutcome): boolean =>
	outcome._tag === "Ran" && !outcome.timedOut && outcome.exitCode === 0;

/**
 * A command's whole stderr, for classification — not {@link describe}'s one quotable line.
 *
 * git prints the connectivity-check failure across two lines, and which line is first is not
 * something this verb should depend on. An unstartable git carries no git diagnostic at all, so it
 * classifies as nothing and refuses at once, which is right: a missing binary is not transient.
 */
const diagnostics = (outcome: ChildOutcome): string =>
	outcome._tag === "Ran" ? new TextDecoder().decode(outcome.stderr) : "";

const git = (
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

interface Attempted {
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
 * Nothing is locked and nothing is serialised (see `RECOVERY_ATTEMPTS`). Any diagnostic
 * {@link concurrencyArm} does not recognise returns on the first attempt, so a genuine failure is
 * never delayed and never retried into looking like one of these.
 */
const withConcurrencyRecovery = (
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
			if (!succeeded(outcome) || outcome._tag !== "Ran") return "main";
			const ref = new TextDecoder().decode(outcome.stdout).trim();
			const slash = ref.indexOf("/");
			return slash > 0 ? ref.slice(slash + 1) : "main";
		}),
	);

/**
 * Provision the tree the plan names, or refuse with the arm that failed.
 *
 * The fetch is not a courtesy. The primary checkout's `origin/main` only advances on an explicit
 * fetch and nothing fetches per spawn, so branching off the cached tip bases a lane on state missing
 * a sibling lane's just-merged commit — two lanes then both go green in isolation and collide at
 * ship time, or one silently reverts the other (#3620/#3678). So the base is what *this* fetch just
 * wrote, never a remote-tracking ref somebody else's fetch maintains, and the fetch still never
 * moves the primary's local `main`.
 *
 * What it is not is `FETCH_HEAD`. That name is shared by every spawn of this clone, so the base
 * travelled through a file a sibling's fetch could truncate mid-read, and the loser's spawn died on
 * `fatal: invalid reference: FETCH_HEAD` (#6081). It lands in a per-spawn ref instead, is resolved to
 * a commit id, and the ref is dropped before the slow `git worktree add` — so nothing this verb
 * branches from has a name another process can write.
 *
 * Both the fetch and the add still run against a clone siblings are adding worktrees to, and two
 * administrative-state faults break them however the base is named — `ConcurrencyArm` beside this
 * verb names them and both of their sources. Each is recovered from by pruning and re-attempting,
 * bounded, and nothing else is: a diagnostic that is not one of those two refuses on its first
 * attempt, and one that is still refuses once the attempts run out.
 */
const provision = (
	plan: WorktreePlan,
	env: Record<string, string>,
	nonce: string,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const base = yield* baseBranch(plan.repoRoot, env);
		const baseRef = baseRefFor(plan.name, nonce);

		const fetched = yield* withConcurrencyRecovery(
			git(fetchBaseArgs(base, baseRef), plan.repoRoot, env),
			plan.repoRoot,
			env,
		);
		if (!succeeded(fetched.outcome)) {
			return refuse(
				BASE_FETCH_FAILED,
				`${VERB}: could not fetch origin/${base}${spent(fetched)} — refusing to branch from a possibly stale base: ${describe(fetched.outcome)}`,
			);
		}

		const resolved = yield* git(resolveBaseArgs(baseRef), plan.repoRoot, env);
		const baseCommit =
			resolved._tag === "Ran" ? new TextDecoder().decode(resolved.stdout).trim() : "";
		// Dropped whatever the resolve said, and before the refusal below, so a spawn that fails here
		// leaves no ref behind; `git worktree add` needs only the id, which is already in hand.
		yield* git(dropBaseRefArgs(baseRef), plan.repoRoot, env);
		if (!succeeded(resolved) || !isCommitId(baseCommit)) {
			return refuse(
				BASE_FETCH_FAILED,
				`${VERB}: fetched origin/${base} and ${baseRef} named no commit — refusing to branch from a base this verb cannot prove: ${describe(resolved)}`,
			);
		}

		// `--detach`: a linked worktree cannot check out a local branch the primary already holds, and
		// every lane re-branches at its own preflight anyway, so this base HEAD is throwaway.
		const added = yield* withConcurrencyRecovery(
			git(["worktree", "add", "--detach", plan.worktreePath, baseCommit], plan.repoRoot, env),
			plan.repoRoot,
			env,
		);
		if (!succeeded(added.outcome)) {
			return refuse(
				WORKTREE_ADD_FAILED,
				`${VERB}: git worktree add --detach ${plan.worktreePath} ${baseCommit} failed${spent(added)}: ${describe(added.outcome)}`,
			);
		}

		const fs = yield* FileSystem.FileSystem;
		// A recovered add reports the status of its last attempt only, so the tree it claims to have
		// built is checked as an artifact before the deps under it are — a `git worktree add` that
		// exits 0 over a window this verb just retried through must not be adopted on its word.
		const created = yield* fs.exists(plan.worktreePath).pipe(Effect.orElseSucceed(() => false));
		if (!created) {
			return refuse(
				WORKTREE_ADD_FAILED,
				`${VERB}: git worktree add exited 0 and ${plan.worktreePath} does not exist — refusing to emit a path to no tree`,
			);
		}

		const provisioned = yield* fs
			.exists(`${plan.worktreePath}/${VIRTUAL_STORE}`)
			.pipe(Effect.orElseSucceed(() => false));
		if (!provisioned) {
			return refuse(
				DEPS_NOT_PROVISIONED,
				`${VERB}: ${plan.worktreePath} has no ${VIRTUAL_STORE} — bootstrap-deps skipped or failed, so the tree would arrive dep-less (ADR 0109 §3)`,
				[`${VERB}: remove the half-built tree with \`git worktree remove ${plan.worktreePath}\``],
			);
		}

		return answer(plan.worktreePath, [
			`${VERB}: provisioned ${plan.worktreePath} at origin/${base}`,
		]);
	});

export const runWorktreeCreate = ({
	stdin,
	dryRun,
	env,
}: WorktreeCreateOptions): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const read = readEnvelope(yield* stdin);

		if (read._tag === "Empty") {
			return refuse(EMPTY_STDIN, `${VERB}: stdin was read and held no ${EVENT} envelope`);
		}
		if (read._tag === "Unknown") {
			return refuse(ENVELOPE_UNKNOWN, `${VERB}: envelope UNKNOWN — ${read.reason}`);
		}
		if (read._tag === "Malformed") {
			return refuse(MALFORMED_ENVELOPE, `${VERB}: not a hook envelope — ${read.reason}`, [
				`${VERB}: ${read.evidence}`,
			]);
		}
		if (read.envelope.event !== EVENT) {
			return refuse(
				WRONG_EVENT,
				`${VERB}: judges ${EVENT} and the envelope is ${read.envelope.event} — the declaration is wired to the wrong event`,
			);
		}

		const planned = planWorktree(read.envelope.payload);
		if (planned._tag === "Unplannable") {
			return refuse(UNPLANNABLE_WORKTREE, `${VERB}: ${planned.reason}`);
		}

		const scope = `${VERB}: ${dryRun ? "would provision" : "provisioning"} ${planned.plan.worktreePath}`;
		if (dryRun) return answer(planned.plan.worktreePath, [scope]);

		const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
		return yield* provision(planned.plan, childEnv(env), nonce).pipe(
			Effect.map((outcome) => ({...outcome, stderr: [scope, ...outcome.stderr]})),
		);
	});
