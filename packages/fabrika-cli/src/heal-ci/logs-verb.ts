/**
 * `heal-ci logs` — the failed-job log text for **every** failing gating context at a head.
 *
 * Every failing context is read, not the first: v1 took `.failing[0]` and discarded the rest with no
 * record in any output field, so an N-context red silently became one routed action and N−1 losses.
 *
 * **A failing required roll-up brings the jobs its FAIL lines name.** Those jobs block only through
 * the roll-up, so each one's frame follows the roll-up's, tied by `./named-jobs.ts` and never by a
 * guess; a red no required roll-up names is still reported and never fetched.
 *
 * **No diagnostic is ever written to stdout.** The log body *is* the answer channel, and v1 wrote its
 * own English error text onto the same stream, interleaved with the log — so a caller
 * pattern-matching for failure signatures matched heal-ci's own prose as if it were CI output.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {commitExists} from "../io/pulls.ts";
import {authorityNote, readBlockingSet, reportedLine, unreadableCause} from "../review/blocking.ts";
import {statusOf} from "../review/rollup.ts";
import {latestPerContext, listRunsAtHead, listShipCheckRuns} from "../ship/github.ts";
import {
	badNumber,
	inspectedSha,
	NULL_TOKEN,
	prefixMatch,
	resolvePull,
	resolveTargetRepo,
} from "../ship/target.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, LOGS_EXPIRED, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {type LogFrame, renderFrame} from "./frames.ts";
import {fetchJobLog, listRunJobs} from "./github.ts";
import {isFailedJob, namedJobsOf, untiedLine} from "./named-jobs.ts";

const VERB = "heal-ci logs";

export interface LogsOptions {
	readonly pr: number;
	readonly sha: string;
	/** Empty means every failing gating context. */
	readonly context: string;
	readonly maxBytes: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** The log's **last** N bytes are kept — the failure is at the end, and truncation is declared. */
export const tailBytes = (
	text: string,
	bound: number,
): {readonly text: string; readonly bytes: number; readonly truncated: boolean} => {
	const encoded = new TextEncoder().encode(text);
	if (encoded.length <= bound) return {text, bytes: encoded.length, truncated: false};
	const kept = encoded.subarray(encoded.length - bound);
	return {text: new TextDecoder("utf-8").decode(kept), bytes: kept.length, truncated: true};
};

export const runLogs = (
	options: LogsOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "a pull-request number", options.pr);
		if (bad !== null) return bad;
		if (options.sha !== "") {
			const checked = inspectedSha(VERB, options.sha);
			if (typeof checked !== "string") return checked;
		}
		if (!Number.isInteger(options.maxBytes) || options.maxBytes < 0) {
			return refuse(
				FAILED,
				`${VERB}: --max-bytes "${options.maxBytes}" is not a non-negative integer.`,
			);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;
		const pr = options.pr;

		const unreadable = (what: string, at: string, reason: string): string =>
			`${VERB}: cannot read ${what} for ${at}: ${reason} — UNKNOWN, never "no failed steps".`;

		const target = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) => unreadable("the pull request", `#${pr}`, reason),
		});
		if (target._tag === "Refused") return target.outcome;
		const bound = options.sha === "" ? target.pull.headSha : options.sha;
		if (options.sha !== "") {
			const at = yield* commitExists(repo, bound);
			if (at._tag === "Absent") {
				return refuse(ZERO_SCOPE, `${VERB}: no commit ${bound} on PR #${pr}.`);
			}
			if (at._tag === "Unknown") {
				return refuse(PRECONDITION_UNKNOWN, unreadable("the commit", bound, at.reason));
			}
		}

		const notices: string[] = [];
		if (!prefixMatch(target.pull.headSha, bound)) {
			notices.push(
				`${VERB}: the live head is ${target.pull.headSha}, you are reading ${bound} — the head moved.`,
			);
		}

		const enumerated = yield* listShipCheckRuns(repo, bound);
		if (enumerated._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				unreadable("the check runs", bound, enumerated.reason),
				notices,
			);
		}
		if (enumerated.value.runs.length < enumerated.value.declared) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${enumerated.value.runs.length} of ${enumerated.value.declared} declared check runs — refusing a partial failure set.`,
				notices,
			);
		}
		// The blocking authority is read before anything is fetched, so a failure the base branch does
		// not require enters this lane only when a failing required roll-up names it — otherwise it
		// leaves named on the notices channel instead.
		const authority = yield* readBlockingSet(repo, target.pull.baseRef);
		if (authority._tag !== "Set") {
			return refuse(
				authority._tag === "Incomplete" ? INCOMPLETE_SCAN : PRECONDITION_UNKNOWN,
				unreadableCause(VERB, target.pull.baseRef, authority),
				notices,
			);
		}
		const latest = latestPerContext(enumerated.value.runs);
		notices.push(authorityNote(VERB, target.pull.baseRef, authority.set));
		const failing = latest
			.filter((run) => authority.set.blocks(run.name))
			.filter((run) => run.status === "completed" && statusOf(run) !== "success")
			.filter((run) => statusOf(run) !== "neutral" && statusOf(run) !== "skipped");

		const selected =
			options.context === "" ? failing : failing.filter((run) => run.name === options.context);
		if (options.context !== "" && selected.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: no gating context "${options.context}" at ${bound} — failing contexts are: ${
					failing.length === 0 ? NULL_TOKEN : failing.map((run) => run.name).join(", ")
				}.`,
				notices,
			);
		}
		if (options.context !== "") {
			notices.push(
				`${VERB}: read ${selected.length} of ${failing.length} failing gating contexts (--context narrowed the read).`,
			);
		}

		const runs = yield* listRunsAtHead(repo, bound);
		if (runs._tag === "Failure") {
			return refuse(PRECONDITION_UNKNOWN, unreadable("the run list", bound, runs.reason), notices);
		}
		if (runs.value.runs.length < runs.value.declared) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${runs.value.runs.length} of ${runs.value.declared} declared workflow runs — refusing a partial failure set.`,
				notices,
			);
		}

		const frames: LogFrame[] = [];
		const emitted = new Set<string>();
		const through = new Map<string, string>();

		/** One job's log as a frame, answering its full text, or the refusal its read earned. */
		const frameOf = (context: string, jobId: number) =>
			Effect.gen(function* () {
				const log = yield* fetchJobLog(repo, jobId);
				if (log._tag === "Expired") {
					return refuse(
						LOGS_EXPIRED,
						`${VERB}: run ${jobId}'s logs are expired — the platform no longer holds them; classify from the check-run summary or re-run to regenerate.`,
						notices,
					);
				}
				if (log._tag === "Failed") {
					return refuse(
						PRECONDITION_UNKNOWN,
						unreadable(`job ${jobId}'s log`, bound, log.reason),
						notices,
					);
				}
				const tail = tailBytes(log.text, options.maxBytes);
				if (tail.truncated) {
					notices.push(
						`${VERB}: context ${context} truncated to the last ${tail.bytes} bytes of ${new TextEncoder().encode(log.text).length}.`,
					);
				}
				emitted.add(context);
				frames.push({
					context,
					jobId: String(jobId),
					bytes: tail.bytes,
					truncated: tail.truncated,
					text: tail.text,
				});
				return log.text;
			});

		for (const check of selected) {
			let job: {readonly id: number; readonly name: string} | null = null;
			for (const run of runs.value.runs) {
				const jobs = yield* listRunJobs(repo, run.id);
				if (jobs._tag === "Failure") {
					return refuse(
						PRECONDITION_UNKNOWN,
						unreadable(`run ${run.id}'s jobs`, bound, jobs.reason),
						notices,
					);
				}
				if (jobs.value.jobs.length < jobs.value.declared) {
					return refuse(
						INCOMPLETE_SCAN,
						`${VERB}: received ${jobs.value.jobs.length} of ${jobs.value.declared} declared jobs — refusing a partial failure set.`,
						notices,
					);
				}
				const match = jobs.value.jobs.find((candidate) => candidate.name === check.name);
				if (match !== undefined) {
					job = match;
					break;
				}
			}

			// A check run posted by an app or an external service has no workflow job and therefore no
			// log. Refusing the whole read would let one external check hide every other failing
			// context's logs — the opposite of this verb's purpose.
			if (job === null) {
				notices.push(
					`${VERB}: context ${check.name} has no workflow job behind it (posted by an external check) — emitted with an empty body.`,
				);
				frames.push({
					context: check.name,
					jobId: NULL_TOKEN,
					bytes: 0,
					truncated: false,
					text: "",
				});
				continue;
			}

			const text = yield* frameOf(check.name, job.id);
			if (typeof text !== "string") return text;

			// A required roll-up's FAIL lines name jobs that block only through it. Each one's frame
			// follows the roll-up's, so `classify` prints the class of the job a `derived` line names.
			const named = yield* namedJobsOf(repo, bound, check, text, runs.value.runs);
			if (named._tag === "Unknown") {
				return refuse(PRECONDITION_UNKNOWN, unreadable(named.what, bound, named.reason), notices);
			}
			if (named._tag === "Incomplete") {
				return refuse(
					INCOMPLETE_SCAN,
					`${VERB}: received ${named.received} of ${named.declared} declared jobs — refusing a partial failure set.`,
					notices,
				);
			}
			for (const untied of named.untied) notices.push(untiedLine(VERB, check.name, untied));
			for (const {key, job: tied} of named.tied) {
				if (authority.set.blocks(tied.name)) continue;
				if (!isFailedJob(tied)) {
					notices.push(
						`${VERB}: ${check.name} names job ${key} (${tied.name}), which concluded ${tied.conclusion ?? tied.status} — no failure log to read.`,
					);
					continue;
				}
				through.set(tied.name, check.name);
				if (emitted.has(tied.name)) continue;
				const followed = yield* frameOf(tied.name, tied.id);
				if (typeof followed !== "string") return followed;
			}
		}

		notices.push(
			...reportedLine(
				VERB,
				authority.set,
				latest,
				selected.length < failing.length
					? {
							_tag: "Unknown",
							reason: "--context narrowed the read past the other failing gating contexts",
						}
					: {_tag: "Read", through},
			),
		);

		return options.json
			? answer(
					JSON.stringify({
						outcome: "logs",
						sha: bound,
						count: frames.length,
						contexts: frames.map((frame) => ({
							name: frame.context,
							jobId: frame.jobId === NULL_TOKEN ? null : Number.parseInt(frame.jobId, 10),
							bytes: frame.bytes,
							truncated: frame.truncated,
							text: frame.text,
						})),
					}),
					notices,
				)
			: answer(
					[`logs\t${frames.length}\t${bound}`, ...frames.map(renderFrame)].join("\n"),
					notices,
				);
	});
