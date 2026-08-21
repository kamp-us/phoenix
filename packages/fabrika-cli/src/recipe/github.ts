/**
 * The Actions reads and the one write the `recipe rerun` verb needs.
 *
 * The house disciplines hold: REST and never GraphQL, every list read pages, a shape that is not what
 * was asked for is a failure rather than an empty result, and the status is read before the body.
 *
 * The credential is an argument to every leg of the client, so each read resolves one from the `env`
 * its caller hands down — never from `process`, which is what keeps a test's environment scripted.
 *
 * **A rerun is proven by re-reading the run, never by the POST's own status.** GitHub answers the
 * rerun endpoint before the run has moved, so the acceptance evidence is the run record itself:
 * either its attempt counter advanced past the one observed before the POST, or it is no longer
 * `completed`. Both are the same claim from two directions, and accepting either keeps a re-read
 * that caught the run mid-transition from reading as a refusal.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {pagedEnvelope, refusalText, resolveToken, restRead} from "../io/gh-api.ts";
import {type Attempt, fail, ok} from "../io/git.ts";
import {isRecord} from "../io/json.ts";

/** An authenticated GitHub read: the transport, plus the spawner the `gh auth token` leg needs. */
type Authed<A> = Effect.Effect<
	A,
	never,
	HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
>;

/** The environment a read resolves its credential from — the caller's, never `process`'s. */
type Env = Readonly<Record<string, string | undefined>>;

/** One workflow run at a head, reduced to the fields the recipe reads. */
export interface WorkflowRun {
	readonly id: number;
	readonly name: string;
	/** `queued` / `in_progress` / `completed` — a run off `completed` is moving. */
	readonly status: string;
	/** `success` / `failure` / …, `null` while the run has not concluded. */
	readonly conclusion: string | null;
	/** The attempt counter GitHub advances when a rerun is accepted. */
	readonly runAttempt: number;
}

const toRun = (value: unknown): WorkflowRun | null => {
	if (!isRecord(value)) return null;
	const {id, name, status, conclusion} = value;
	if (typeof id !== "number" || typeof status !== "string") return null;
	const attempt = value.run_attempt;
	return {
		id,
		name: typeof name === "string" ? name : "",
		status,
		conclusion: typeof conclusion === "string" ? conclusion : null,
		runAttempt: typeof attempt === "number" ? attempt : 1,
	};
};

const SHAPE = "GitHub answered 200 but its body is not a workflow run";

/**
 * Every workflow run recorded against `sha`, paged in full.
 *
 * A short list is a failure, not a shorter answer: a walk that read fewer runs than the endpoint
 * declared would answer "no failed run at this head" from a page nobody read, and the caller seats
 * that as "nothing to rerun" — a proven no-op it never proved. The `gh --paginate` era proved that
 * over stdout bytes, refusing a stream that stopped mid-page; the envelope's `total_count` is the
 * same refusal against the platform's own declaration, and it is the only thing that catches a walk
 * stopped by the page cap.
 */
export const listRunsAtHead = (
	repo: string,
	sha: string,
	env: Env,
): Authed<Attempt<ReadonlyArray<WorkflowRun>>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const read = yield* pagedEnvelope(
			token.value,
			`repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}`,
			"workflow_runs",
		);
		if (read._tag === "Failure") return read;
		const {declared, entries} = read.value;
		if (entries.length < declared) {
			return fail(
				`the workflow-run list at ${sha} is short — GitHub declared ${declared} run(s) and ${entries.length} arrived`,
			);
		}
		const runs: WorkflowRun[] = [];
		for (const value of entries) {
			const run = toRun(value);
			if (run === null) return fail(SHAPE);
			runs.push(run);
		}
		return ok(runs);
	});

/** One workflow run, re-read — the evidence a rerun was accepted. */
export const getRun = (repo: string, id: number, env: Env): Authed<Attempt<WorkflowRun>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const outcome = yield* restRead(token.value, "GET", `repos/${repo}/actions/runs/${id}`);
		if (outcome._tag === "Unreachable") return fail(outcome.reason);
		if (outcome.status < 200 || outcome.status >= 300) {
			return fail(refusalText(outcome));
		}
		const run = toRun(outcome.body);
		return run === null ? fail(SHAPE) : ok(run);
	});

/** Ask GitHub to rerun a whole workflow run — the endpoint `gh run rerun` posted to. */
export const rerunRun = (repo: string, id: number, env: Env): Authed<Attempt<void>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const outcome = yield* restRead(token.value, "POST", `repos/${repo}/actions/runs/${id}/rerun`);
		if (outcome._tag === "Unreachable") return fail(outcome.reason);
		return outcome.status >= 200 && outcome.status < 300
			? ok<void>(undefined)
			: fail(refusalText(outcome));
	});

/** Whether a re-read proves the rerun landed: a new attempt, or a run that is no longer completed. */
export const rerunAccepted = (before: WorkflowRun, after: WorkflowRun): boolean =>
	after.runAttempt > before.runAttempt || after.status !== "completed";
