/**
 * `hook worktree-create` — the provider verb behind a repo's `WorktreeCreate` hook.
 *
 * It exists because the harness's own worktree path leaves the tree **dep-less**. That path execs
 * git hooks with a stripped `PATH`, so the repo's `post-checkout` install finds no corepack, no
 * pinned pnpm and no npm, and clean-SKIPs at exit 0 — a silent skip that is byte-identical, from the
 * outside, to a successful install. Every `isolation: worktree` shell then pays an install before
 * its first verb, or fails at exit 126 on it.
 *
 * A `WorktreeCreate` hook **replaces** that path, and that is the whole mechanism: this verb creates
 * the tree itself, under a `PATH` that resolves the toolchain and a 600s hook budget, so the repo's
 * own `post-checkout` install actually runs. The creating is `worktree-owner.ts`'s; this file reads
 * the envelope, reaps, and hands the plan over.
 *
 * **Every failure arm refuses, and a refusal blocks the spawn.** That is deliberate: the harness
 * reads any non-zero exit as a creation failure and does not fall back to git, so a blocked spawn is
 * the only honest alternative to handing an agent a tree this verb could not finish.
 */
import {randomUUID} from "node:crypto";
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type ChildOutcome, execRecord} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	EMPTY_STDIN,
	ENVELOPE_UNKNOWN,
	MALFORMED_ENVELOPE,
	UNPLANNABLE_WORKTREE,
	WRONG_EVENT,
} from "./codes.ts";
import {type LockHost, thisProcess} from "./creation-lock.ts";
import {classifyEnvelope, type EnvelopeRead} from "./envelope.ts";
import {
	childEnv,
	listWorktreesArgs,
	locateToplevel,
	planAtPrimary,
	REAP_LIMIT,
	REAP_TIMEOUT_SECONDS,
	readWorktreeRequest,
	reapArgs,
	showToplevelArgs,
} from "./worktree-create.ts";
import {
	CAPTURE_BYTES,
	createWorktree,
	describeOutcome,
	firstLine,
	git,
	type Requirements,
	succeeded,
} from "./worktree-owner.ts";

const VERB = "fabrika hook worktree-create";
const EVENT = "WorktreeCreate";

/** How to re-enter this CLI as a child — the node binary running now, and its own entry module. */
export interface CliEntry {
	readonly node: string;
	readonly entry: string;
}

export interface WorktreeCreateOptions {
	readonly stdin: Effect.Effect<StdinRead>;
	/** Plan and report, mutate nothing. The declared hook can never pass it — rule 5 forbids flags. */
	readonly dryRun: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** `null` skips the reap-before-provision sweep — a process that cannot name its own entrypoint. */
	readonly cli: CliEntry | null;
	/** This process's identity for the creation lock; a test states which pids are alive through it. */
	readonly host?: LockHost;
}

const readEnvelope = (piped: StdinRead): EnvelopeRead =>
	piped._tag === "Text" ? classifyEnvelope(piped.text) : {_tag: "Unknown", reason: piped.reason};

const stdoutIfSucceeded = (outcome: ChildOutcome): string | null =>
	succeeded(outcome) && outcome._tag === "Ran" ? new TextDecoder().decode(outcome.stdout) : null;

/**
 * Reclaim what this clone can before the tree is provisioned, and report what happened.
 *
 * The answer is a stderr line and never a refusal — see {@link REAP_LIMIT}'s note: a reclaimer that
 * could block a spawn would turn a housekeeping miss into the total stop it exists to prevent. So
 * every outcome, including a sweep the timeout cut off, folds into one line here.
 *
 * It runs before the creation lock is taken, so a sweep never holds a sibling spawn's fetch.
 *
 * The sweep's own verdicts are `build reap`'s and are not re-derived: what this reports is only
 * whether it ran.
 */
const reapFirst = (
	cli: CliEntry | null,
	repoRoot: string,
	env: Record<string, string>,
): Effect.Effect<ReadonlyArray<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (cli === null) {
			return [
				`${VERB}: reaped nothing before provisioning — this process cannot name its own entrypoint.`,
			];
		}
		const swept = yield* execRecord({
			file: cli.node,
			args: reapArgs(cli.entry),
			cwd: repoRoot,
			env,
			timeoutSeconds: REAP_TIMEOUT_SECONDS,
			captureBytes: CAPTURE_BYTES,
		});
		return succeeded(swept)
			? [`${VERB}: reaped before provisioning — ${lastLine(swept)}`]
			: [
					`${VERB}: the reap before provisioning did not finish — ${describeSweep(swept)}. The spawn is unaffected and the sweep re-runs on the next one.`,
				];
	});

/**
 * Why the sweep did not finish, in its own terms.
 *
 * Not the owner's `describeOutcome`: that one names git and quotes the git children's budget, and
 * this child is neither — a line saying `git did not finish within 540s` about a 120s node run sends
 * its reader to the wrong process and the wrong clock.
 */
const describeSweep = (outcome: ChildOutcome): string => {
	if (outcome._tag === "Unstartable") return `the sweep could not start — ${outcome.reason}`;
	if (outcome.timedOut) return `it ran past its ${REAP_TIMEOUT_SECONDS}s bound and was cut off`;
	return firstLine(outcome.stderr) || `it exited ${outcome.exitCode}`;
};

/** A child's last stderr line — for `build reap`, the sweep's own count of what it did. */
const lastLine = (outcome: ChildOutcome): string => {
	if (outcome._tag !== "Ran") return "the sweep reported nothing";
	const lines = new TextDecoder()
		.decode(outcome.stderr)
		.split("\n")
		.filter((line) => line.trim() !== "");
	return lines.at(-1) ?? "the sweep reported nothing";
};

export const runWorktreeCreate = ({
	stdin,
	dryRun,
	env,
	cli,
	host = thisProcess,
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

		const requested = readWorktreeRequest(read.envelope.payload);
		if (requested._tag === "Unplannable") {
			return refuse(UNPLANNABLE_WORKTREE, `${VERB}: ${requested.reason}`);
		}

		const child = childEnv(env);
		const resolved = yield* git(showToplevelArgs, requested.request.cwd, child);
		const located = locateToplevel(requested.request, stdoutIfSucceeded(resolved));
		if (located._tag === "Unplannable") {
			return refuse(UNPLANNABLE_WORKTREE, `${VERB}: ${located.reason}`, [
				`${VERB}: git rev-parse --show-toplevel: ${describeOutcome(resolved)}`,
			]);
		}

		const listed = yield* git(listWorktreesArgs, located.toplevel, child);
		const planned = planAtPrimary(requested.request, stdoutIfSucceeded(listed));
		if (planned._tag === "Unplannable") {
			return refuse(UNPLANNABLE_WORKTREE, `${VERB}: ${planned.reason}`, [
				`${VERB}: git worktree list --porcelain -z: ${describeOutcome(listed)}`,
			]);
		}

		const scope = `${VERB}: ${dryRun ? "would provision" : "provisioning"} ${planned.plan.worktreePath}`;
		if (dryRun) return answer(planned.plan.worktreePath, [scope]);

		const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
		const swept = yield* reapFirst(cli, planned.plan.repoRoot, child);
		return yield* createWorktree(planned.plan, child, nonce, host).pipe(
			Effect.map((outcome) => ({...outcome, stderr: [scope, ...swept, ...outcome.stderr]})),
		);
	});
