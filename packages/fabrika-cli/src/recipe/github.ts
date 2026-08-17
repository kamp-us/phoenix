/**
 * The Actions reads and the one write the `recipe rerun` verb needs.
 *
 * The house disciplines hold: `gh api` REST and never GraphQL, every list read pages, a shape that
 * is not what was asked for is a failure rather than an empty result, and `ok` is read before
 * `stdout`.
 *
 * **A rerun is proven by re-reading the run, never by the POST's own status.** GitHub answers the
 * rerun endpoint before the run has moved, so the acceptance evidence is the run record itself:
 * either its attempt counter advanced past the one observed before the POST, or it is no longer
 * `completed`. Both are the same claim from two directions, and accepting either keeps a re-read
 * that caught the run mid-transition from reading as a refusal.
 */
import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {scanJsonPages} from "../io/issues.ts";
import {isRecord, parseJson} from "../io/json.ts";

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

const SHAPE = "`gh api` exited 0 but its output is not a workflow run";

/**
 * Every workflow run recorded against `sha`, paged in full.
 *
 * Unaccounted bytes are a failure, not a shorter list: a stream that stopped mid-page would answer
 * "no failed run at this head" from a page nobody read, and the caller seats that as "nothing to
 * rerun" — a proven no-op it never proved.
 */
export const listRunsAtHead = (
	repo: string,
	sha: string,
): Shell<Attempt<ReadonlyArray<WorkflowRun>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const scanned = scanJsonPages(r.stdout);
		if (scanned.truncated !== null) return fail(scanned.truncated);
		const runs: WorkflowRun[] = [];
		for (const page of scanned.pages) {
			const parsed = parseJson(page);
			// The Actions list endpoint wraps its rows; a bare array is a shape nobody asked for.
			if (!isRecord(parsed) || !Array.isArray(parsed.workflow_runs)) {
				return fail("`gh api` exited 0 but its output is not a workflow-run page");
			}
			for (const value of parsed.workflow_runs) {
				const run = toRun(value);
				if (run === null) return fail(SHAPE);
				runs.push(run);
			}
		}
		return ok(runs);
	});

/** One workflow run, re-read — the evidence a rerun was accepted. */
export const getRun = (repo: string, id: number): Shell<Attempt<WorkflowRun>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/actions/runs/${id}`]);
		if (!r.ok) return fail(r.reason);
		const run = toRun(parseJson(r.stdout));
		return run === null ? fail(SHAPE) : ok(run);
	});

/** Ask GitHub to rerun a whole workflow run — the endpoint `gh run rerun` posts to. */
export const rerunRun = (repo: string, id: number): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"POST",
			`repos/${repo}/actions/runs/${id}/rerun`,
		]);
		return r.ok ? ok<void>(undefined) : fail(r.reason);
	});

/** Whether a re-read proves the rerun landed: a new attempt, or a run that is no longer completed. */
export const rerunAccepted = (before: WorkflowRun, after: WorkflowRun): boolean =>
	after.runAttempt > before.runAttempt || after.status !== "completed";
