/**
 * The GitHub surface this group reads and writes beyond what `../io/pulls.ts` and `../ship/github.ts`
 * already serve — the protection surface, the job logs, and the rerun request.
 *
 * Two of these are the only genuinely new IO in the group: **fetching a workflow job's log text**
 * and **requesting a rerun**. Everything else composes shipped modules, and the pagination proofs
 * are `../io/gh-api.ts`'s, imported rather than re-derived.
 *
 * The disciplines are the shipped ones, restated nowhere: every response's status is read before its
 * bytes, and proven-absent is split from could-not-read at every seam. Since the port off `gh`
 * (ADR 0315) the status is a number the response carried rather than a code scraped out of an error
 * string, so `Absent` and `Unknown` are told apart by the platform's own answer.
 *
 * **Where the credential comes from.** Every leg of the client takes a token as an argument, so each
 * read here resolves one, and `env` is the last parameter of every read rather than something a read
 * reaches for out of `process`. That is the package's shape: the environment enters at the verb and
 * is passed down, which is also what keeps a test's environment scripted rather than inherited.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	existenceOf,
	type PagedAttempt,
	pagedEnvelope,
	pagedWithLinkProof,
	resolveToken,
	restRead,
} from "../io/gh-api.ts";
import {type Attempt, fail, ok} from "../io/git.ts";
import {type Existence, unknown} from "../io/issues.ts";
import {isRecord} from "../io/json.ts";

/** An authenticated GitHub read: the transport, plus the spawner the `gh auth token` leg needs. */
type Authed<A> = Effect.Effect<
	A,
	never,
	HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
>;

/** The environment a read resolves its credential from — the caller's, never `process`'s. */
type Env = Readonly<Record<string, string | undefined>>;

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
export const listRunJobs = (repo: string, run: number, env: Env): Authed<Attempt<JobSet>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const enveloped = yield* pagedEnvelope(
			token.value,
			`repos/${repo}/actions/runs/${run}/jobs`,
			"jobs",
		);
		if (enveloped._tag === "Failure") return enveloped;
		const jobs: WorkflowJob[] = [];
		for (const value of enveloped.value.entries) {
			if (!isRecord(value) || typeof value.id !== "number") {
				return fail("GitHub answered 200 but one entry is not a workflow job");
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
 *
 * **The endpoint answers `302` to a signed blob URL, and that redirect is followed with the
 * `Authorization` header dropped** — which is what makes this leg work at all. Probed against this
 * package's runtime (Node 26, `FetchHttpClient` over `globalThis.fetch`, which sets no `redirect`
 * option and so follows): the signed URL answers `403` when the header is *present* and `200` when
 * it is absent, and a default-follow fetch of the API URL answers `200` — so the runtime strips the
 * header on the cross-origin hop, per the Fetch standard's HTTP-redirect step. Nothing here has to
 * follow the redirect by hand, and nothing may re-attach the credential to the signed URL.
 */
export const fetchJobLog = (repo: string, job: number, env: Env): Authed<LogRead> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return {_tag: "Failed" as const, reason: token.reason};
		const outcome = yield* restRead(token.value, "GET", `repos/${repo}/actions/jobs/${job}/logs`);
		if (outcome._tag === "Unreachable") {
			return {_tag: "Failed" as const, reason: outcome.reason};
		}
		if (outcome.status >= 200 && outcome.status < 300) {
			return {_tag: "Text" as const, text: outcome.text};
		}
		return outcome.status === 410 || outcome.status === 404
			? {_tag: "Expired" as const}
			: {_tag: "Failed" as const, reason: `GitHub answered HTTP ${outcome.status}`};
	});

export interface RunRecord {
	readonly id: number;
	readonly headSha: string;
	readonly status: string;
	readonly conclusion: string | null;
	readonly runAttempt: number;
}

const toRunRecord = (value: unknown): Attempt<RunRecord> => {
	if (!isRecord(value) || typeof value.id !== "number") {
		return fail("GitHub answered 200 but its body is not a workflow run");
	}
	return ok({
		id: value.id,
		headSha: str(value.head_sha),
		status: str(value.status),
		conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
		runAttempt: typeof value.run_attempt === "number" ? value.run_attempt : 1,
	});
};

/** One workflow run — the rerun guard's second and third preconditions read from here. */
export const getWorkflowRun = (repo: string, run: number, env: Env): Authed<Existence<RunRecord>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return unknown<RunRecord>(token.reason);
		const outcome = yield* restRead(token.value, "GET", `repos/${repo}/actions/runs/${run}`);
		return existenceOf(outcome, toRunRecord);
	});

/**
 * Request a re-run of a run's **failed jobs only**.
 *
 * The 2xx this returns is a dispatch acknowledgement and **not** proof that a new attempt exists —
 * the caller re-reads the run and requires `run_attempt` to have increased before it records
 * anything. v1 wrote its durable marker on the strength of this response and thereby blocked every
 * future rerun of a run that never re-ran.
 */
export const rerunFailedJobs = (repo: string, run: number, env: Env): Authed<Attempt<void>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const outcome = yield* restRead(
			token.value,
			"POST",
			`repos/${repo}/actions/runs/${run}/rerun-failed-jobs`,
		);
		if (outcome._tag === "Unreachable") return fail(outcome.reason);
		return outcome.status >= 200 && outcome.status < 300
			? ok<void>(undefined)
			: fail(`GitHub answered HTTP ${outcome.status}`);
	});

/**
 * A read's answer beside the status GitHub served — which is what a permission denial is told apart
 * by, now that no error string carries the code (ADR 0315).
 */
export interface Answered<A> {
	readonly read: A;
	/** The status GitHub answered, or `null` when it was never reached and served none. */
	readonly status: number | null;
}

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
	env: Env,
): Authed<Answered<Existence<ReadonlyArray<string>>>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") {
			return {read: unknown<ReadonlyArray<string>>(token.reason), status: null};
		}
		const outcome = yield* restRead(
			token.value,
			"GET",
			`repos/${repo}/branches/${branch}/protection`,
		);
		const read = existenceOf<ReadonlyArray<string>>(outcome, (body) => {
			if (!isRecord(body))
				return fail("GitHub answered 200 but its body is not a protection record");
			const required = body.required_status_checks;
			if (!isRecord(required) || !Array.isArray(required.contexts)) return ok([]);
			return ok(required.contexts.filter((c): c is string => typeof c === "string"));
		});
		return {read, status: outcome._tag === "Unreachable" ? null : outcome.status};
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
export const rulesetContexts = (
	repo: string,
	branch: string,
	env: Env,
): Authed<PagedAttempt<RulesetRead>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return {...token, status: null};
		const read = yield* pagedWithLinkProof(token.value, `repos/${repo}/rules/branches/${branch}`);
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
	env: Env,
): Authed<Attempt<{readonly rows: ReadonlyArray<OpenPullRow>; readonly exhausted: boolean}>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const read = yield* pagedWithLinkProof(token.value, `repos/${repo}/pulls?state=open`);
		if (read._tag === "Failure") return read;
		const rows: OpenPullRow[] = [];
		for (const entry of read.value.entries) {
			if (!isRecord(entry) || typeof entry.number !== "number") {
				return fail("GitHub answered 200 but one entry is not a pull request");
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
export const readRateLimit = (env: Env): Authed<Attempt<RateLimit>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const outcome = yield* restRead(token.value, "GET", "rate_limit");
		if (outcome._tag === "Unreachable") return fail(outcome.reason);
		if (outcome.status < 200 || outcome.status >= 300) {
			return fail(`GitHub answered HTTP ${outcome.status}`);
		}
		const parsed = outcome.body;
		const core =
			isRecord(parsed) && isRecord(parsed.resources) && isRecord(parsed.resources.core)
				? parsed.resources.core
				: null;
		if (core === null || typeof core.remaining !== "number") {
			return fail("GitHub answered 200 but the rate-limit record declares no core remaining");
		}
		const reset = typeof core.reset === "number" ? new Date(core.reset * 1000).toISOString() : "";
		return ok({remaining: core.remaining, resetsAt: reset});
	});

/** When the head commit was pushed — the left operand of the strand age, read at the commit. */
export const commitPushedAt = (repo: string, sha: string, env: Env): Authed<Attempt<string>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const outcome = yield* restRead(token.value, "GET", `repos/${repo}/commits/${sha}`);
		if (outcome._tag === "Unreachable") return fail(outcome.reason);
		if (outcome.status < 200 || outcome.status >= 300) {
			return fail(`GitHub answered HTTP ${outcome.status}`);
		}
		const commit = isRecord(outcome.body) ? outcome.body.commit : null;
		const committer = isRecord(commit) ? commit.committer : null;
		const at = isRecord(committer) ? str(committer.date).trim() : "";
		return at === "" ? fail("GitHub answered 200 but named no commit date") : ok(at);
	});
