/**
 * The gate's own assertion of the governance floor at the head it just posted to.
 *
 * `governance-floor.yml` triggers on `pull_request` alone, so it always runs *before* the verdict it
 * looks for can exist — a governance verdict is written by an agent that has to read the diff first.
 * The job reads comment state at its own start, finds no verdict at the head, exits 18, and no
 * comment write can re-fire a `pull_request`-triggered job. Every governance-root PR therefore reds
 * at least once and only a re-run clears it (#5585).
 *
 * The founder ruled the fix direction on 2026-08-16: the gate's own post asserts the floor at its own
 * head. The gate is the one actor with no ordering problem — it knows it just wrote the verdict — and
 * the fix stays inside this package rather than editing `.github/workflows/`, which CODEOWNERS assigns
 * to the control plane.
 *
 * **Asserting is re-deriving, never claiming.** Nothing here writes a check-run or a status: it
 * re-fires the floor job, which re-runs `ship floor` against live comment state and reaches its own
 * verdict. A fabricated green is the one outcome this module must never be able to produce.
 *
 * The run IO is imported from the two homes that already serve it — `../ship/github.ts` for the runs
 * at a head, `../heal-ci/github.ts` for one run and the rerun request. A third copy of either is how
 * two groups come to disagree about what the platform returns.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getWorkflowRun, rerunFailedJobs} from "../heal-ci/github.ts";
import {listRunsAtHead} from "../ship/github.ts";

/** The floor workflow's `name:`, which is what a run at a head carries. */
export const FLOOR_WORKFLOW_NAME = "governance-floor";

/** The conclusions that leave the check red. Anything else at `completed` is not a red to clear. */
const RED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

export type FloorAssertion =
	/** No floor run at this head: the workflow is not installed here, or it has not fired yet. */
	| {readonly _tag: "NoRun"}
	/** The run at this head already concluded green — the check reflects the gate's state. */
	| {readonly _tag: "Green"; readonly run: number}
	/** The run is still going, so it may yet judge state older than the verdict just written. */
	| {readonly _tag: "InFlight"; readonly run: number}
	/** A new attempt exists and is re-deriving `ship floor` against live comment state. */
	| {readonly _tag: "Refired"; readonly run: number; readonly attempt: number}
	/**
	 * The re-fire took but GitHub has not published its attempt number yet: the run this verb read as
	 * completed-and-red a moment ago is running again under the same id. That transition is proof from
	 * run state, so it is a re-fire to wait on rather than an unread one to escalate (#5982).
	 */
	| {readonly _tag: "Restarting"; readonly run: number; readonly status: string}
	/** The floor state could not be read or the re-fire could not be proven. Never a pass. */
	| {readonly _tag: "Unknown"; readonly reason: string};

const unknown = (reason: string): FloorAssertion => ({_tag: "Unknown", reason});

/**
 * Re-fire the red governance-floor run at `sha`, and prove a new attempt exists.
 *
 * The dispatch's 2xx is an acknowledgement and not a new attempt, so the run is re-read and the
 * re-fire is proven from run state — `heal-ci rerun` learned that the hard way, and reporting a
 * re-fire that never happened would leave the caller believing a red will clear itself. Either
 * signal proves it: `run_attempt` increased, or the completed-and-red run is running again under the
 * same id while the counter catches up.
 */
export const assertFloorAt = (
	repo: string,
	sha: string,
	env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<
	FloorAssertion,
	never,
	HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const listed = yield* listRunsAtHead(repo, sha);
		if (listed._tag === "Failure") return unknown(listed.reason);
		if (listed.value.runs.length < listed.value.declared) {
			return unknown(
				`received ${listed.value.runs.length} of ${listed.value.declared} declared runs at ${sha}`,
			);
		}
		const floors = listed.value.runs.filter((run) => run.name === FLOOR_WORKFLOW_NAME);
		if (floors.length === 0) return {_tag: "NoRun"};
		// The newest run at this head, by id. A head can carry several — a re-created PR, a retriggered
		// workflow — and the check the PR shows is the last one.
		const latest = floors.reduce((held, run) => (run.id > held.id ? run : held));
		if (latest.status !== "completed") return {_tag: "InFlight", run: latest.id};
		if (!RED_CONCLUSIONS.has(latest.conclusion ?? "")) return {_tag: "Green", run: latest.id};

		const before = yield* getWorkflowRun(repo, latest.id, env);
		if (before._tag !== "Present") {
			return unknown(
				before._tag === "Absent"
					? `run ${latest.id} is not in ${repo}`
					: `run ${latest.id}: ${before.reason}`,
			);
		}
		const requested = yield* rerunFailedJobs(repo, latest.id, env);
		if (requested._tag === "Failure") return unknown(requested.reason);
		const after = yield* getWorkflowRun(repo, latest.id, env);
		if (after._tag !== "Present") {
			return unknown(
				`the re-fire was requested and the confirming read of run ${latest.id} failed — UNKNOWN whether it re-ran`,
			);
		}
		if (after.value.runAttempt <= before.value.runAttempt) {
			// The attempt counter lags the dispatch, and reading its absence as UNKNOWN sent three agents
			// to `heal-ci` over re-fires that had taken (#5982). A run this verb just read as
			// completed-and-red that is running again under the same id can only be running because of
			// this dispatch — that is proof from run state, which is the one thing the counter was here
			// to supply. A still-`completed` run proves nothing and stays UNKNOWN.
			return after.value.status === "completed"
				? unknown(
						`the re-fire was requested and run ${latest.id} stayed at attempt ${after.value.runAttempt}, still completed — UNKNOWN whether it re-ran`,
					)
				: {_tag: "Restarting", run: latest.id, status: after.value.status};
		}
		return {_tag: "Refired", run: latest.id, attempt: after.value.runAttempt};
	});

/** The one-token closed vocabulary a caller emits under `--json`. */
export const floorToken = (assertion: FloorAssertion): string => {
	switch (assertion._tag) {
		case "NoRun":
			return "no-run";
		case "Green":
			return "green";
		case "InFlight":
			return "in-flight";
		case "Refired":
			return "refired";
		case "Restarting":
			return "restarting";
		case "Unknown":
			return "unknown";
	}
};

/** The stderr line, which states what the caller must do next when the floor is not asserted. */
export const floorLine = (verb: string, assertion: FloorAssertion): string => {
	switch (assertion._tag) {
		case "NoRun":
			return `${verb}: no ${FLOOR_WORKFLOW_NAME} run at this head — the floor is not installed in this repository, or it has not fired yet.`;
		case "Green":
			return `${verb}: ${FLOOR_WORKFLOW_NAME} run ${assertion.run} already reads green at this head — nothing to re-fire.`;
		case "InFlight":
			return `${verb}: ${FLOOR_WORKFLOW_NAME} run ${assertion.run} is still in flight, so it may judge comment state older than this verdict — re-read the check and re-post if it reds.`;
		case "Refired":
			return `${verb}: re-fired ${FLOOR_WORKFLOW_NAME} run ${assertion.run} at attempt ${assertion.attempt} — it re-derives \`ship floor\` against this verdict (#5585).`;
		case "Restarting":
			return `${verb}: re-fired ${FLOOR_WORKFLOW_NAME} run ${assertion.run} — it is ${assertion.status} again and GitHub has not published the new attempt number yet; wait and re-read run ${assertion.run}, there is nothing to escalate.`;
		case "Unknown":
			return `${verb}: the ${FLOOR_WORKFLOW_NAME} check could not be asserted at this head: ${assertion.reason} — the verdict landed; the check may still need a re-fire.`;
	}
};
