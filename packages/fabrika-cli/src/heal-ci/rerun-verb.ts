/**
 * `heal-ci rerun` — the at-most-once transient rerun, precondition re-derived **inside the verb**.
 *
 * The guard is the single most important clause in this group's contract, and it lives here because
 * v1's counterpart accepted no already-rerun input and performed no check of its own: the whole
 * one-rerun invariant rested on the model remembering a number it had read several steps earlier. A
 * session-memory invariant is not an invariant, so a caller that has convinced itself a second rerun
 * is warranted still cannot get one.
 *
 * Steps 4-6 are one logical operation whose ordering is deliberate: the rerun before the marker means
 * an interrupted run leaves a re-runnable state rather than a permanently blocked one, and the
 * read-back is what makes the marker true.
 *
 * This verb takes no view on whether the rerun is wise — where the failing context is itself a gate
 * checking its own output a bounded retry can be actively harmful (#5335); that judgment is the
 * skill's and is exercised before this verb is called.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment, listComments} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {
	badNumber,
	inspectedSha,
	prefixMatch,
	resolvePull,
	resolveTargetRepo,
} from "../ship/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	INCOMPLETE_SCAN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	PROVEN_NOT_IN_STATE,
	READBACK_MISMATCH,
	RERUN_UNRECORDED,
	STALE_HEAD,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {getWorkflowRun, rerunFailedJobs} from "./github.ts";
import {markerBoundTo, renderMarker} from "./marker.ts";
import {isSignatureId, SIGNATURE_IDS} from "./signatures.ts";

const VERB = "heal-ci rerun";

/** The conclusions a rerun is defined over. Anything else is a run that did not fail. */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled"]);

export interface RerunOptions {
	readonly pr: number;
	readonly run: number;
	readonly sha: string;
	readonly signature: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runRerun = (
	options: RerunOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "a pull-request number", options.pr);
		if (bad !== null) return bad;
		const badRun = badNumber(VERB, "a workflow run id", options.run);
		if (badRun !== null) return badRun;
		const bound = inspectedSha(VERB, options.sha);
		if (typeof bound !== "string") return bound;
		if (!isSignatureId(options.signature)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --signature ${options.signature} is not a known classify signature id (known: ${SIGNATURE_IDS.join(", ")}).`,
			);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;
		const pr = options.pr;

		const unreadable = (what: string, reason: string): string =>
			`${VERB}: cannot read ${what}: ${reason} — nothing was requested.`;

		const target = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) => unreadable(`PR #${pr}`, reason),
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		// 1. Re-derive the head binding. A rerun justified by a diagnosis of one tree must not fire
		//    against another.
		if (!prefixMatch(pull.headSha, bound)) {
			return refuse(
				STALE_HEAD,
				`${VERB}: the live head is ${pull.headSha}, you diagnosed ${bound} — refusing to rerun against a tree nobody classified.`,
			);
		}
		if (pull.state !== "open" || pull.merged || pull.draft) {
			const state = pull.merged ? "merged" : pull.draft ? "draft" : "closed";
			return refuse(PROVEN_NOT_IN_STATE, `${VERB}: PR #${pr} is ${state} — nothing to rerun.`);
		}

		// 2. Re-derive the failure state.
		const found = yield* getWorkflowRun(repo, options.run);
		if (found._tag === "Absent") {
			return refuse(ZERO_SCOPE, `${VERB}: PR #${pr} or run ${options.run} not found in ${repo}.`);
		}
		if (found._tag === "Unknown") {
			return refuse(PRECONDITION_UNKNOWN, unreadable(`run ${options.run}`, found.reason));
		}
		const run = found.value;
		if (!prefixMatch(run.headSha, bound)) {
			return refuse(
				PROVEN_NOT_IN_STATE,
				`${VERB}: run ${options.run} belongs to ${run.headSha}, not ${bound} — refusing to rerun a run this head never produced.`,
			);
		}
		if (run.status !== "completed" || !FAILED_CONCLUSIONS.has(run.conclusion ?? "")) {
			return refuse(
				PROVEN_NOT_IN_STATE,
				`${VERB}: run ${options.run} concluded ${run.conclusion ?? run.status}, not a failure — refusing to rerun a run that did not fail.`,
			);
		}

		// 3. Re-derive at-most-once from two independent signals, both fully paginated. Each covers the
		//    other's hole: `run_attempt` can be bumped by a human or another tool, and a marker can be
		//    edited away.
		if (run.runAttempt >= 2) {
			return refuse(
				PROVEN_NOT_IN_STATE,
				`${VERB}: head ${bound} was already rerun (run_attempt=${run.runAttempt}) — a second rerun is escalation, not retry.`,
			);
		}
		const commented = yield* listComments(repo, pr);
		if (commented._tag === "Failure") {
			return refuse(PRECONDITION_UNKNOWN, unreadable(`#${pr}'s comments`, commented.reason));
		}
		if (commented.value.length < pull.comments) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${commented.value.length} of ${pull.comments} declared comments — refusing to license a rerun over a truncated marker read.`,
			);
		}
		const held = markerBoundTo(commented.value, pull.headSha);
		if (held !== null) {
			return refuse(
				PROVEN_NOT_IN_STATE,
				`${VERB}: head ${bound} was already rerun (marker ${held.id}) — a second rerun is escalation, not retry.`,
			);
		}

		const diagnostics = [
			`${VERB}: ${repo}#${pr} @ ${pull.headSha}, run ${options.run} at attempt ${run.runAttempt}; scanned ${commented.value.length} comments.`,
		];

		// 4. Request the rerun of the failed jobs only.
		const requested = yield* rerunFailedJobs(repo, options.run);
		if (requested._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the rerun request failed: ${requested.reason} — no new attempt, no marker written.`,
				diagnostics,
			);
		}

		// 5. Read back the run. A 2xx that materialised no new attempt writes NO marker — v1 wrote one
		//    on the strength of the dispatch response and blocked every future rerun of a run that
		//    never re-ran.
		const after = yield* getWorkflowRun(repo, options.run);
		if (after._tag !== "Present") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the request was sent and the confirming read failed — UNKNOWN whether it re-ran; no marker written, re-read before retrying.`,
				diagnostics,
			);
		}
		if (after.value.runAttempt <= run.runAttempt) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the request was sent and run_attempt did not increase — UNKNOWN whether it re-ran; no marker written, re-read before retrying.`,
				diagnostics,
			);
		}
		const attempt = after.value.runAttempt;

		// 6. Write the marker, and read it back.
		const body = renderMarker({
			head: pull.headSha,
			run: options.run,
			signature: options.signature,
		});
		const posted = yield* createComment(repo, pr, body);
		if (posted._tag === "Failure") {
			return refuse(
				RERUN_UNRECORDED,
				`${VERB}: the rerun landed at attempt ${attempt} and the marker could not be written: ${posted.reason} — this head is rerun and UNRECORDED; the next reader will see it as fresh. Escalate now.`,
				diagnostics,
			);
		}
		const landed = yield* getComment(repo, posted.value.id);
		if (landed._tag === "Failure") {
			return refuse(
				RERUN_UNRECORDED,
				`${VERB}: the rerun landed at attempt ${attempt} and the marker read-back could not be taken: ${landed.reason} — treat this head as rerun and UNRECORDED. Escalate now.`,
				diagnostics,
			);
		}
		if (normalizeForReadback(landed.value) !== normalizeForReadback(body)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the rerun landed at attempt ${attempt} and the marker read-back does not match — the rerun is real, the record is not; inspect comment ${posted.value.id}.`,
				diagnostics,
			);
		}

		return options.json
			? answer(
					JSON.stringify({
						outcome: "rerun",
						attempt,
						run: options.run,
						markerUrl: posted.value.url,
					}),
					diagnostics,
				)
			: answer(`rerun\t${attempt}\t${options.run}\t${posted.value.url}`, diagnostics);
	});
