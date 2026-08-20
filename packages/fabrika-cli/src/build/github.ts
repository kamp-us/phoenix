/**
 * The GitHub reads and writes the `build` verbs need beyond what `io/issues.ts` and `io/pulls.ts`
 * already serve.
 *
 * The house disciplines hold unchanged across the move off `gh` (ADR 0315): REST and **never
 * GraphQL**, **every list read pages**, *proven absent* split from *unreadable*, and a shape that is
 * not what was asked for treated as a failure rather than an empty result. The pagination is the one
 * this group most depends on — a truncated bucket is the un-paginated scar these verbs exist to
 * close (#4926), and a candidate pool that silently stops at 100 answers "no p0s".
 *
 * What the transport changed is where two of those facts come from, not what they mean. The 404 that
 * makes an answer `Absent` is now the response's own status rather than `(HTTP 404)` scraped out of
 * a `gh` error string, and a paged read's completeness is now the `Link` header's exhaustion rather
 * than a scan for unaccounted bytes on a killed `gh`'s stdout. Both are still values the caller
 * refuses on.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	attemptOf,
	existenceOf,
	pagedWithLinkProof,
	resolveToken,
	restRead,
	restWrite,
} from "../io/gh-api.ts";
import {type Attempt, fail, ok} from "../io/git.ts";
import {type Existence, unknown} from "../io/issues.ts";
import {isRecord} from "../io/json.ts";

/**
 * What these functions need: the HTTP client they call over, and the spawner `resolveToken` may
 * reach for when neither env var names a credential.
 */
type Called<A> = Effect.Effect<
	A,
	never,
	HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
>;

/** One issue as the candidate pool ranks it — every axis the filter reads, none of them derived. */
export interface CandidateIssue {
	readonly number: number;
	readonly title: string;
	readonly labels: ReadonlyArray<string>;
	readonly assigned: boolean;
	readonly milestone: number | null;
	readonly isPullRequest: boolean;
	/**
	 * The issue body, `""` when the payload carried none. The listing endpoint already returns it, so
	 * the pool's criteria axis costs no second call.
	 */
	readonly body: string;
}

const toCandidate = (value: unknown): CandidateIssue | null => {
	if (!isRecord(value)) return null;
	const {number, title, labels, assignees, milestone} = value;
	if (typeof number !== "number" || typeof title !== "string") return null;
	const names = Array.isArray(labels)
		? labels.map((l) => (isRecord(l) && typeof l.name === "string" ? l.name : null))
		: null;
	if (names === null || names.includes(null)) return null;
	return {
		number,
		title,
		labels: names as ReadonlyArray<string>,
		assigned: Array.isArray(assignees) ? assignees.length > 0 : value.assignee !== null,
		milestone:
			isRecord(milestone) && typeof milestone.number === "number" ? milestone.number : null,
		isPullRequest: value.pull_request !== undefined,
		body: typeof value.body === "string" ? value.body : "",
	};
};

const truncated = (what: string): string =>
	`the ${what} read stopped at the page cap with another page outstanding`;

/**
 * Every open issue carrying **all** of `labels`, paged in full.
 *
 * Typed JSON rather than a projection: the filter reads five axes off each row, and one odd entry
 * must red the read rather than shorten the list silently — which is exactly the truncation the
 * caller refuses on. A read that walked to the page cap with a `rel="next"` still outstanding is a
 * partial board that would read as the whole board, so it is a failure here, which the pool seats as
 * `11`.
 */
export const listLabelled = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	labels: ReadonlyArray<string>,
): Called<Attempt<ReadonlyArray<CandidateIssue>>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const read = yield* pagedWithLinkProof(
			token.value,
			`repos/${repo}/issues?state=open&labels=${encodeURIComponent(labels.join(","))}`,
		);
		if (read._tag === "Failure") return read;
		if (!read.value.exhausted) return fail(truncated("candidate pool"));
		const rows: CandidateIssue[] = [];
		for (const value of read.value.entries) {
			const row = toCandidate(value);
			if (row === null) return fail("GitHub answered 200 but one entry is not an issue");
			rows.push(row);
		}
		return ok(rows);
	});

/**
 * An issue's parent epic, through the dedicated sub-endpoint.
 *
 * The single-issue payload carries **no** `parent` key, so reading `.parent` there answers a
 * well-formed, plausible, always-wrong "standalone" (#4171). The sub-endpoint's 404 is the
 * proven-standalone answer; everything else stays UNKNOWN.
 */
export const getParent = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	issue: number,
): Called<Existence<number>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return unknown<number>(token.reason);
		const outcome = yield* restRead(token.value, "GET", `repos/${repo}/issues/${issue}/parent`);
		return existenceOf(outcome, (body) => {
			const number = isRecord(body) ? body.number : undefined;
			return typeof number === "number"
				? ok(number)
				: fail("GitHub answered 200 but named no parent number");
		});
	});

/** Whether a number is a pull request, read off the issues endpoint's `pull_request` key. */
export const isPullRequest = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	number: number,
): Called<Existence<boolean>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return unknown<boolean>(token.reason);
		const outcome = yield* restRead(token.value, "GET", `repos/${repo}/issues/${number}`);
		return existenceOf(outcome, (body) =>
			isRecord(body)
				? ok(body.pull_request !== undefined && body.pull_request !== null)
				: fail("GitHub answered 200 but its body is not an issue"),
		);
	});

export const defaultBranch = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
): Called<Attempt<string>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const outcome = yield* restRead(token.value, "GET", `repos/${repo}`);
		return attemptOf(outcome, (body) => {
			const name = isRecord(body) ? body.default_branch : undefined;
			return typeof name === "string" && name.trim() !== ""
				? ok(name.trim())
				: fail("GitHub answered 200 but named no default branch");
		});
	});

export interface PullHead {
	readonly ref: string;
	readonly sha: string;
	readonly state: string;
	readonly merged: boolean;
}

/** A PR's head branch — what resume mode publishes back to through a tracked upstream. */
export const getPullHead = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	pr: number,
): Called<Existence<PullHead>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return unknown<PullHead>(token.reason);
		const outcome = yield* restRead(token.value, "GET", `repos/${repo}/pulls/${pr}`);
		return existenceOf(outcome, (body) => {
			if (!isRecord(body) || !isRecord(body.head)) {
				return fail("GitHub answered 200 but its body is not a pull request");
			}
			const {ref, sha} = body.head;
			const state = body.state;
			return typeof ref === "string" &&
				ref !== "" &&
				typeof sha === "string" &&
				typeof state === "string"
				? ok({ref, sha, state, merged: body.merged === true})
				: fail("GitHub answered 200 but its output is not a pull-request head");
		});
	});

export interface PullRef {
	readonly number: number;
	readonly url: string;
}

const toPullRef = (body: unknown, what: string): Attempt<PullRef> =>
	isRecord(body) && typeof body.number === "number" && typeof body.html_url === "string"
		? ok({number: body.number, url: body.html_url})
		: fail(`GitHub answered 2xx but its body is not ${what}`);

/**
 * The open PR whose head is `branch`, or `null` when there is none.
 *
 * This is what makes `build pr` idempotent after a `8`: a create whose outcome could not be proven is
 * re-run, and an already-open PR for this head is an **answer**, not a duplicate.
 *
 * The exhaustion proof only binds the empty answer. A found PR is the first row and no further page
 * can unseat it; "there is no open PR for this head" is the one reading a page nobody fetched could
 * overturn.
 */
export const openPullForHead = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	branch: string,
): Called<Attempt<PullRef | null>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const owner = repo.split("/")[0] ?? "";
		const read = yield* pagedWithLinkProof(
			token.value,
			`repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
		);
		if (read._tag === "Failure") return read;
		const first = read.value.entries[0];
		if (first === undefined) {
			return read.value.exhausted ? ok(null) : fail(truncated("open pull request"));
		}
		return toPullRef(first, "a list of pull requests");
	});

/** Open a pull request. */
export const createPull = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	title: string,
	head: string,
	base: string,
	body: string,
): Called<Attempt<PullRef>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const outcome = yield* restWrite(token.value, "POST", `repos/${repo}/pulls`, {
			title,
			head,
			base,
			body,
		});
		return attemptOf(outcome, (payload) => toPullRef(payload, "a created pull request"));
	});

/**
 * Replace an open pull request's body, and move nothing else.
 *
 * A `PATCH` carrying only `body` is what lets a body-only defect — the recurring one is a
 * `## Deviations` section the review gate reads as malformed — be repaired without a push (#5618).
 */
export const updatePullBody = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	pr: number,
	body: string,
): Called<Attempt<PullRef>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const outcome = yield* restWrite(token.value, "PATCH", `repos/${repo}/pulls/${pr}`, {body});
		return attemptOf(outcome, (payload) => toPullRef(payload, "an updated pull request"));
	});

/** One native review on a pull request — its own row kind, never coerced into a marker (#4555). */
export interface ReviewRecord {
	readonly id: number;
	readonly state: string;
	readonly body: string;
}

export const listReviews = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	pr: number,
): Called<Attempt<ReadonlyArray<ReviewRecord>>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const read = yield* pagedWithLinkProof(token.value, `repos/${repo}/pulls/${pr}/reviews`);
		if (read._tag === "Failure") return read;
		if (!read.value.exhausted) return fail(truncated("review"));
		const rows: ReviewRecord[] = [];
		for (const value of read.value.entries) {
			if (!isRecord(value) || typeof value.id !== "number" || typeof value.state !== "string") {
				return fail("GitHub answered 200 but one entry is not a review");
			}
			rows.push({
				id: value.id,
				state: value.state,
				body: typeof value.body === "string" ? value.body : "",
			});
		}
		return ok(rows);
	});
