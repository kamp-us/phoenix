/**
 * The GitHub surface this group reads and writes beyond what `../io/pulls.ts` and `../ship/github.ts`
 * already serve — the protection surface, the job logs, and the rerun request.
 *
 * Two of these are the only genuinely new IO in the group: **fetching a workflow job's log text**
 * and **requesting a rerun**. Everything else composes shipped modules, and the pagination proof is
 * `../ship/github.ts`'s `pagedWithLinkProof`, imported rather than re-derived.
 *
 * The disciplines are the shipped ones, restated nowhere: every `gh` exit status is read before its
 * bytes, and proven-absent is split from could-not-read at every seam.
 */
import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {absent, type Existence, httpStatusOf, present, unknown} from "../io/issues.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {pagedEnvelope, pagedWithLinkProof} from "../ship/github.ts";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** One workflow job at a run — the log read's target, and the failing-job filter's subject. */
export interface WorkflowJob {
	readonly id: number;
	readonly name: string;
	readonly status: string;
	readonly conclusion: string | null;
}

export interface JobSet {
	readonly declared: number;
	readonly jobs: ReadonlyArray<WorkflowJob>;
}

/** Every job of one run, paged, with the platform's declared count beside what arrived. */
export const listRunJobs = (repo: string, run: number): Shell<Attempt<JobSet>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/actions/runs/${run}/jobs?per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const enveloped = pagedEnvelope(r.stdout, "jobs");
		if (enveloped._tag === "Failure") return enveloped;
		const jobs: WorkflowJob[] = [];
		for (const value of enveloped.value.entries) {
			if (!isRecord(value) || typeof value.id !== "number") {
				return fail("`gh api` exited 0 but one entry is not a workflow job");
			}
			jobs.push({
				id: value.id,
				name: str(value.name),
				status: str(value.status),
				conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
			});
		}
		return ok({declared: enveloped.value.declared, jobs});
	});

/** A run's log availability: the platform serves the bytes, has purged them, or could not be asked. */
export type LogRead =
	| {readonly _tag: "Text"; readonly text: string}
	/** Proven: the platform no longer holds these logs. Permanent, so no retry can change it. */
	| {readonly _tag: "Expired"}
	| {readonly _tag: "Failed"; readonly reason: string};

/**
 * One job's log text.
 *
 * `410 Gone` is the platform's own word for expired or purged logs, and it is a **verdict about the
 * run** rather than a failed read — folding it into a transport failure would tell the caller to
 * retry a read that can never succeed.
 *
 * `404` is read the same way, and only because of where this call sits: the caller has already read
 * the run and enumerated its jobs over this same token, so a job id this endpoint denies is one whose
 * bytes are gone rather than one the token cannot see. Outside that ordering a `404` would be
 * ambiguous, and folding could-not-read into proven-absent is the collapse the group forbids.
 */
export const fetchJobLog = (repo: string, job: number): Shell<LogRead> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/actions/jobs/${job}/logs`]);
		if (r.ok) return {_tag: "Text" as const, text: r.stdout};
		const status = httpStatusOf(r.reason);
		return status === 410 || status === 404
			? {_tag: "Expired" as const}
			: {_tag: "Failed" as const, reason: r.reason};
	});

export interface RunRecord {
	readonly id: number;
	readonly headSha: string;
	readonly status: string;
	readonly conclusion: string | null;
	readonly runAttempt: number;
}

const toRunRecord = (value: unknown): RunRecord | null => {
	if (!isRecord(value) || typeof value.id !== "number") return null;
	return {
		id: value.id,
		headSha: str(value.head_sha),
		status: str(value.status),
		conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
		runAttempt: typeof value.run_attempt === "number" ? value.run_attempt : 1,
	};
};

/** One workflow run — the rerun guard's second and third preconditions read from here. */
export const getWorkflowRun = (repo: string, run: number): Shell<Existence<RunRecord>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/actions/runs/${run}`]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404 ? absent<RunRecord>() : unknown<RunRecord>(r.reason);
		}
		const record = toRunRecord(parseJson(r.stdout));
		return record === null
			? unknown<RunRecord>("`gh api` exited 0 but its output is not a workflow run")
			: present(record);
	});

/**
 * Request a re-run of a run's **failed jobs only**.
 *
 * The 2xx this returns is a dispatch acknowledgement and **not** proof that a new attempt exists —
 * the caller re-reads the run and requires `run_attempt` to have increased before it records
 * anything. v1 wrote its durable marker on the strength of this response and thereby blocked every
 * future rerun of a run that never re-ran.
 */
export const rerunFailedJobs = (repo: string, run: number): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"POST",
			`repos/${repo}/actions/runs/${run}/rerun-failed-jobs`,
		]);
		return r.ok ? ok<void>(undefined) : fail(r.reason);
	});

/**
 * What a base branch's protection endpoint said — and the one thing its 404 does **not** say.
 *
 * `GET /branches/{branch}/protection` answers `404 "Branch not protected"` both when a branch
 * genuinely has no protection and when the caller lacks the admin permission to see it. It is
 * ambiguous by construction, so `Absent` here is never on its own evidence of anything.
 */
export const branchProtectionContexts = (
	repo: string,
	branch: string,
): Shell<Existence<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/branches/${branch}/protection`]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404
				? absent<ReadonlyArray<string>>()
				: unknown<ReadonlyArray<string>>(r.reason);
		}
		const parsed = parseJson(r.stdout);
		if (!isRecord(parsed)) {
			return unknown<ReadonlyArray<string>>(
				"`gh api` exited 0 but its output is not a protection record",
			);
		}
		const required = parsed.required_status_checks;
		if (!isRecord(required) || !Array.isArray(required.contexts)) return present([]);
		return present(required.contexts.filter((c): c is string => typeof c === "string"));
	});

export interface RulesetRead {
	readonly contexts: ReadonlyArray<string>;
	/** True only when a terminal page arrived carrying no `rel="next"` link. */
	readonly exhausted: boolean;
	readonly scanned: number;
}

/**
 * The required status contexts every repository ruleset imposes on one branch.
 *
 * The read is `GET /repos/{repo}/rules/branches/{branch}`, which is the **platform's own evaluation**
 * of each ruleset's ref condition against this branch. Enumerating `/rulesets` and re-deriving which
 * conditions match would be a second implementation of `fnmatch` over include/exclude patterns,
 * `~DEFAULT_BRANCH` and `~ALL` — a platform semantic this package does not get to guess at. Both
 * endpoints answer at ordinary `repo` scope, so nothing about the permission finding changes: a
 * permission denial here is `unprobeable`, never "no requirements".
 */
export const rulesetContexts = (repo: string, branch: string): Shell<Attempt<RulesetRead>> =>
	Effect.gen(function* () {
		const read = yield* pagedWithLinkProof(`repos/${repo}/rules/branches/${branch}`);
		if (read._tag === "Failure") return read;
		const contexts: string[] = [];
		for (const entry of read.value.entries) {
			if (!isRecord(entry) || entry.type !== "required_status_checks") continue;
			const parameters = entry.parameters;
			if (!isRecord(parameters) || !Array.isArray(parameters.required_status_checks)) continue;
			for (const check of parameters.required_status_checks) {
				if (isRecord(check) && typeof check.context === "string") contexts.push(check.context);
			}
		}
		return ok({
			contexts,
			exhausted: read.value.exhausted,
			scanned: read.value.entries.length,
		});
	});

export interface OpenPullRow {
	readonly number: number;
	readonly headSha: string;
}

/**
 * Every open pull request, walked to a **terminal page**.
 *
 * The open-PR list declares no total, so the only completeness proof available is a page carrying no
 * `rel="next"` — and a sweep that answered over an unproven list would report a quiet board it never
 * finished reading.
 */
export const listOpenPulls = (
	repo: string,
): Shell<Attempt<{readonly rows: ReadonlyArray<OpenPullRow>; readonly exhausted: boolean}>> =>
	Effect.gen(function* () {
		const read = yield* pagedWithLinkProof(`repos/${repo}/pulls?state=open`);
		if (read._tag === "Failure") return read;
		const rows: OpenPullRow[] = [];
		for (const entry of read.value.entries) {
			if (!isRecord(entry) || typeof entry.number !== "number") {
				return fail("`gh api` exited 0 but one entry is not a pull request");
			}
			const head = entry.head;
			rows.push({
				number: entry.number,
				headSha: isRecord(head) ? str(head.sha) : "",
			});
		}
		return ok({rows, exhausted: read.value.exhausted});
	});

export interface RateLimit {
	readonly remaining: number;
	/** ISO-8601 UTC, so a refusal can name when the sweep may be retried. */
	readonly resetsAt: string;
}

/** The core rate limit, which a full-board sweep is capable of exhausting on its own. */
export const readRateLimit = (): Shell<Attempt<RateLimit>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", "rate_limit"]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		const core =
			isRecord(parsed) && isRecord(parsed.resources) && isRecord(parsed.resources.core)
				? parsed.resources.core
				: null;
		if (core === null || typeof core.remaining !== "number") {
			return fail("`gh api` exited 0 but the rate-limit record declares no core remaining");
		}
		const reset = typeof core.reset === "number" ? new Date(core.reset * 1000).toISOString() : "";
		return ok({remaining: core.remaining, resetsAt: reset});
	});

/** When the head commit was pushed — the left operand of the strand age, read at the commit. */
export const commitPushedAt = (repo: string, sha: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			`repos/${repo}/commits/${sha}`,
			"--jq",
			".commit.committer.date",
		]);
		if (!r.ok) return fail(r.reason);
		const at = r.stdout.trim();
		return at === "" ? fail("`gh api` exited 0 but named no commit date") : ok(at);
	});
