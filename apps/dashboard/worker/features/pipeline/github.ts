/**
 * The GitHub REST I/O seam (`.patterns/feature-services.md`,
 * `effect-context-service.md`). `GithubClient` is the single Tag wrapping the
 * authenticated `fetch` calls to GitHub's REST API for `kamp-us/phoenix` —
 * deliberately the ONLY module in the feature that touches the network, so the
 * pure parse core (`parse.ts`) stays unit-testable without it.
 *
 * REST only — never GraphQL (the kamp-us org's Projects-classic integration breaks
 * GraphQL issue queries). Auth is a `secret_text` `GITHUB_TOKEN` binding read via
 * `effect/Config` (`config.ts`), mirroring apps/web's `BETTER_AUTH_SECRET`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {githubToken} from "../../config.ts";
import {GithubFetchError} from "./errors.ts";

const GITHUB_API = "https://api.github.com";
const REPO = "kamp-us/phoenix";
const PER_PAGE = 100;

/** Cap the surfaced GitHub body so a pathological response can't bloat the error. */
const MAX_DETAIL = 2000;

/**
 * The raw issue shape the client returns — exactly the GitHub REST fields the
 * parse core consumes. `parent` is GitHub's sub-issue back-reference; `pull_request`
 * marks a row the issues endpoint returns that is actually a PR (filtered out).
 */
export interface RawIssue {
	readonly number: number;
	readonly title: string;
	readonly state: string;
	readonly body: string | null;
	readonly labels: ReadonlyArray<{readonly name: string}>;
	readonly pull_request?: unknown;
}

/** A `sub_issues` child row — only the number is load-bearing for the relation. */
export interface RawSubIssue {
	readonly number: number;
}

/** An open PR row: its number, body (carries `Fixes #N`), and web URL for the UI link. */
export interface RawPullRequest {
	readonly number: number;
	readonly body: string | null;
	readonly html_url: string;
}

/** A PR/issue comment reduced to the fields verdict resolution reads. */
export interface RawComment {
	readonly body: string;
	readonly created_at: string;
}

export class GithubClient extends Context.Service<
	GithubClient,
	{
		/**
		 * All open + closed issues for `kamp-us/phoenix` (PRs filtered out),
		 * following pagination to completion.
		 */
		readonly listIssues: Effect.Effect<ReadonlyArray<RawIssue>, GithubFetchError>;
		/** The `sub_issues` children of one epic (the list endpoint, source of truth). */
		readonly listSubIssues: (
			epic: number,
		) => Effect.Effect<ReadonlyArray<RawSubIssue>, GithubFetchError>;
		/** All open PRs for `kamp-us/phoenix`, following pagination to completion. */
		readonly listOpenPullRequests: Effect.Effect<ReadonlyArray<RawPullRequest>, GithubFetchError>;
		/** The issue/PR comments for one number (PRs share the issue comments endpoint). */
		readonly listComments: (
			number: number,
		) => Effect.Effect<ReadonlyArray<RawComment>, GithubFetchError>;
	}
>()("@kampus/dashboard/pipeline/GithubClient") {}

export const GithubClientLive = Layer.effect(GithubClient)(
	Effect.gen(function* () {
		// `orDie`: a malformed/absent token binding is a deploy misconfig, not a
		// request-time domain error — die rather than widen every method's `E`.
		const token = yield* githubToken.pipe(Effect.orDie);

		const headers: HeadersInit = {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${Redacted.value(token)}`,
			"user-agent": "phoenix-dashboard",
			"x-github-api-version": "2022-11-28",
		};

		const getJson = Effect.fn("GithubClient.getJson")(function* (path: string) {
			const res = yield* Effect.tryPromise({
				try: () => fetch(`${GITHUB_API}${path}`, {headers}),
				catch: (cause) =>
					new GithubFetchError({
						path,
						status: null,
						message: `transport error: ${String(cause)}`,
						detail: null,
					}),
			});
			if (!res.ok) {
				// Best-effort: GitHub's body carries the actual reason ("Resource not
				// accessible…" vs a rate-limit). The read can itself fail/timeout, so it's
				// guarded — a failed read degrades to `detail: null`, never crashing the
				// request path (issue #292). Bounded to MAX_DETAIL.
				const detail = yield* Effect.tryPromise(() => res.text()).pipe(
					Effect.map(
						(text) => (text.length > MAX_DETAIL ? text.slice(0, MAX_DETAIL) : text) || null,
					),
					Effect.orElseSucceed(() => null),
				);
				return yield* new GithubFetchError({
					path,
					status: res.status,
					message: `GitHub returned ${res.status}`,
					detail,
				});
			}
			return yield* Effect.tryPromise({
				try: () => res.json() as Promise<unknown>,
				catch: (cause) =>
					new GithubFetchError({
						path,
						status: res.status,
						message: `bad JSON: ${String(cause)}`,
						detail: null,
					}),
			});
		});

		const listIssues = Effect.gen(function* () {
			const all: RawIssue[] = [];
			// Cap pagination so a runaway repo can't loop forever; 50 pages × 100 is
			// far beyond the live backlog.
			for (let page = 1; page <= 50; page++) {
				const path = `/repos/${REPO}/issues?state=all&per_page=${PER_PAGE}&page=${page}`;
				const batch = (yield* getJson(path)) as ReadonlyArray<RawIssue>;
				if (batch.length === 0) break;
				for (const issue of batch) {
					// The issues endpoint returns PRs too — a PR row carries `pull_request`.
					if (issue.pull_request === undefined) all.push(issue);
				}
				if (batch.length < PER_PAGE) break;
			}
			return all as ReadonlyArray<RawIssue>;
		});

		const listSubIssues = Effect.fn("GithubClient.listSubIssues")(function* (epic: number) {
			const path = `/repos/${REPO}/issues/${epic}/sub_issues?per_page=${PER_PAGE}`;
			return (yield* getJson(path)) as ReadonlyArray<RawSubIssue>;
		});

		const listOpenPullRequests = Effect.gen(function* () {
			const all: RawPullRequest[] = [];
			for (let page = 1; page <= 50; page++) {
				const path = `/repos/${REPO}/pulls?state=open&per_page=${PER_PAGE}&page=${page}`;
				const batch = (yield* getJson(path)) as ReadonlyArray<RawPullRequest>;
				if (batch.length === 0) break;
				all.push(...batch);
				if (batch.length < PER_PAGE) break;
			}
			return all as ReadonlyArray<RawPullRequest>;
		});

		const listComments = Effect.fn("GithubClient.listComments")(function* (number: number) {
			const path = `/repos/${REPO}/issues/${number}/comments?per_page=${PER_PAGE}`;
			return (yield* getJson(path)) as ReadonlyArray<RawComment>;
		});

		return {listIssues, listSubIssues, listOpenPullRequests, listComments};
	}),
);
