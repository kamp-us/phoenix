/**
 * `recipe rerun` — rerun a driver PR's failed workflow runs, and only behind a `governance` PASS at
 * the PR's live head.
 *
 * The gate is read first and the rerun is the only write, in that order: a verdict that is absent,
 * bound to another head, or FAIL refuses before anything is posted, so a refusal here is a proven
 * no-op. The three refusals stay three codes because their remedies are opposite — form a verdict,
 * re-form it at this head, or repair the PR — and folding any two is how a stale PASS comes to
 * authorise a rerun at a head nobody judged.
 *
 * Each rerun is proven by re-reading its own run record, never by the POST's status
 * ([`github.ts`](./github.ts)). A run whose re-read shows no new attempt is a mismatch, not a
 * success with a caveat.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {listComments} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {bindToHead, read as readMarker} from "../wire/verdict-marker.ts";
import {
	NOTHING_TO_RERUN,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	RERUN_UNKNOWN,
	VERDICT_ABSENT,
	VERDICT_FAIL,
	VERDICT_STALE,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {getRun, listRunsAtHead, rerunAccepted, rerunRun, type WorkflowRun} from "./github.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "fabrika recipe rerun";

/** The namespace `governance post` emits, and the only one this recipe reads. */
const NAMESPACE = "governance";

export interface RerunOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runRerun = (
	options: RerunOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(
			VERB,
			repo,
			pr,
			(reason) =>
				`${VERB}: cannot read PR #${pr}: ${reason} — the verdict state is UNKNOWN, never "PASS".`,
		);
		if (target._tag === "Refused") return target.outcome;
		const head = target.pull.headSha;

		const listed = yield* listComments(repo, pr);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${pr}'s comments: ${listed.reason} — the verdict state is UNKNOWN, never "PASS".`,
			);
		}
		const diagnostics = [scannedLine(VERB, listed.value.length, "comment", `head ${head}`)];

		// Latest wins by write stamp, not by creation: a FAIL upserted into an older comment after a
		// PASS is the current verdict, and `created_at` would order it behind (#4200).
		let latest: {readonly polarity: string; readonly sha: string; readonly at: string} | null =
			null;
		for (const comment of listed.value) {
			const parsed = readMarker(comment.body);
			if (parsed._tag !== "Found" || parsed.value.namespace !== NAMESPACE) continue;
			const bound = bindToHead(parsed.value, head);
			if (latest !== null && comment.updatedAt < latest.at) continue;
			latest = {
				polarity: bound._tag === "Current" ? parsed.value.polarity : "stale",
				sha: parsed.value.sha,
				at: comment.updatedAt,
			};
		}
		if (latest === null) {
			return refuse(
				VERDICT_ABSENT,
				`${VERB}: #${pr} carries no ${NAMESPACE} verdict — form one before anything is rerun.`,
				diagnostics,
			);
		}
		if (latest.polarity === "stale") {
			return refuse(
				VERDICT_STALE,
				`${VERB}: #${pr}'s latest ${NAMESPACE} verdict is bound to ${latest.sha}, not the live head ${head} — re-form it at this head; nothing was rerun.`,
				diagnostics,
			);
		}
		if (latest.polarity !== "PASS") {
			return refuse(
				VERDICT_FAIL,
				`${VERB}: #${pr}'s ${NAMESPACE} verdict at ${head} is ${latest.polarity} — repair the PR; nothing was rerun.`,
				diagnostics,
			);
		}

		const runs = yield* listRunsAtHead(repo, head);
		if (runs._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the workflow runs at ${head}: ${runs.reason} — whether anything failed is UNKNOWN, never "nothing".`,
				diagnostics,
			);
		}
		const failed = runs.value.filter((run) => run.conclusion === "failure");
		diagnostics.push(
			scannedLine(VERB, runs.value.length, "workflow run", `${failed.length} concluded failure`),
		);
		if (failed.length === 0) {
			return refuse(
				NOTHING_TO_RERUN,
				`${VERB}: no workflow run at ${head} concluded in failure — there is nothing to rerun.`,
				diagnostics,
			);
		}

		const rerun: Array<{id: number; name: string; attempt: number}> = [];
		for (const run of failed) {
			const proven = yield* rerunOne(repo, run);
			if (proven._tag === "Refused") {
				return {
					...proven.outcome,
					stderr: [...diagnostics, ...proven.outcome.stderr],
				};
			}
			rerun.push({id: run.id, name: run.name, attempt: proven.attempt});
		}

		return answer(JSON.stringify({pr, head, verdict: "PASS", rerun}), [
			...diagnostics,
			`${VERB}: rerequested ${rerun.length} run(s), each proven by its own re-read.`,
		]);
	});

type RerunProof =
	| {readonly _tag: "Accepted"; readonly attempt: number}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

const rerunOne = (
	repo: string,
	run: WorkflowRun,
): Effect.Effect<RerunProof, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const posted = yield* rerunRun(repo, run.id);
		if (posted._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					WRITE_UNKNOWN,
					`${VERB}: the rerun of run ${run.id} (${run.name}) did not land: ${posted.reason} — it is NOT rerequested.`,
				),
			};
		}
		const after = yield* getRun(repo, run.id);
		if (after._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					RERUN_UNKNOWN,
					`${VERB}: run ${run.id} (${run.name}) was rerequested and could not be re-read: ${after.reason} — whether it was accepted is UNKNOWN.`,
				),
			};
		}
		return rerunAccepted(run, after.value)
			? {_tag: "Accepted" as const, attempt: after.value.runAttempt}
			: {
					_tag: "Refused" as const,
					outcome: refuse(
						READBACK_MISMATCH,
						`${VERB}: run ${run.id} (${run.name}) still reads attempt ${after.value.runAttempt} and status "${after.value.status}" — the rerun is NOT proven.`,
					),
				};
	});
