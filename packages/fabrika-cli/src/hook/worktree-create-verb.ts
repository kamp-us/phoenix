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
 * the envelope and hands the plan over.
 *
 * It provisions and does nothing else: no sweep of other worktrees runs here, so a spawn never
 * waits on a scan of every tree on disk.
 * @ruling https://github.com/kamp-us/phoenix/issues/10342
 *
 * **Every failure arm refuses, and a refusal blocks the spawn.** That is deliberate: the harness
 * reads any non-zero exit as a creation failure and does not fall back to git, so a blocked spawn is
 * the only honest alternative to handing an agent a tree this verb could not finish.
 */
import {randomUUID} from "node:crypto";
import {Effect} from "effect";
import type {ChildOutcome} from "../io/exec.ts";
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
	readWorktreeRequest,
	showToplevelArgs,
} from "./worktree-create.ts";
import {
	createWorktree,
	describeOutcome,
	git,
	type Requirements,
	succeeded,
} from "./worktree-owner.ts";

const VERB = "fabrika hook worktree-create";
const EVENT = "WorktreeCreate";

export interface WorktreeCreateOptions {
	readonly stdin: Effect.Effect<StdinRead>;
	/** Plan and report, mutate nothing. The declared hook can never pass it — rule 5 forbids flags. */
	readonly dryRun: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** This process's identity for the creation lock; a test states which pids are alive through it. */
	readonly host?: LockHost;
}

const readEnvelope = (piped: StdinRead): EnvelopeRead =>
	piped._tag === "Text" ? classifyEnvelope(piped.text) : {_tag: "Unknown", reason: piped.reason};

const stdoutIfSucceeded = (outcome: ChildOutcome): string | null =>
	succeeded(outcome) && outcome._tag === "Ran" ? new TextDecoder().decode(outcome.stdout) : null;

export const runWorktreeCreate = ({
	stdin,
	dryRun,
	env,
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
		return yield* createWorktree(planned.plan, child, nonce, host).pipe(
			Effect.map((outcome) => ({...outcome, stderr: [scope, ...outcome.stderr]})),
		);
	});
