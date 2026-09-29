/**
 * The GitHub REST boundary: one filtered read of the open issues this watch could have filed, and
 * the create or update a lagging package owes. The credential is the workflow's `GITHUB_TOKEN`.
 */
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {ACTIONS_BOT, type IssueText, type OpenIssue, TRIAGE_LABEL} from "./release-watch.ts";

const API_ROOT = "https://api.github.com";

/** A GitHub call failed, answered an unexpected status, or its read was incomplete. */
export class GithubError extends Schema.TaggedError<GithubError>()(
	"@kampus/release-watch/GithubError",
	{
		message: Schema.String,
	},
) {}

export interface GithubTarget {
	readonly repo: string;
	readonly token: string;
}

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

export const targetFromEnv = (
	env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<GithubTarget, GithubError> => {
	const repo = (env.GITHUB_REPOSITORY ?? "").trim();
	const token = (env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "").trim();
	if (!REPO_RE.test(repo)) {
		return Effect.fail(
			new GithubError({message: "set GITHUB_REPOSITORY to the owner/name to file issues in"}),
		);
	}
	if (token === "")
		return Effect.fail(new GithubError({message: "set GITHUB_TOKEN (or GH_TOKEN)"}));
	return Effect.succeed({repo, token});
};

const IssuesPage = Schema.Array(
	Schema.Struct({
		number: Schema.Int,
		title: Schema.String,
		body: Schema.NullOr(Schema.String),
		pull_request: Schema.optional(Schema.Unknown),
	}),
);

const request = (
	target: GithubTarget,
	method: "GET" | "POST" | "PATCH",
	path: string,
	body?: Readonly<Record<string, unknown>>,
) => {
	const base = HttpClientRequest.make(method)(`${API_ROOT}/${path}`).pipe(
		HttpClientRequest.setHeaders({
			authorization: `Bearer ${target.token}`,
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			"user-agent": "kampus-release-watch",
		}),
	);
	const sent = body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body);
	return HttpClient.execute(sent).pipe(
		Effect.flatMap(HttpClientResponse.filterStatusOk),
		Effect.mapError((cause) => new GithubError({message: `${method} ${path}: ${cause.message}`})),
	);
};

const NEXT_LINK = /<[^>]*>\s*;\s*rel="next"/i;

/**
 * The open issues the Actions bot authored, in one request. A second page means the read is not
 * the whole set, and a partial read could miss the standing issue and file a duplicate, so it
 * refuses instead.
 */
export const openBotIssues = Effect.fn("Github.openBotIssues")(function* (target: GithubTarget) {
	const creator = encodeURIComponent(ACTIONS_BOT);
	const path = `repos/${target.repo}/issues?state=open&creator=${creator}&per_page=100`;
	const response = yield* request(target, "GET", path);
	if (NEXT_LINK.test(response.headers.link ?? "")) {
		return yield* new GithubError({
			message: `GET ${path}: more than one page of open bot issues; refusing a partial read`,
		});
	}
	const page = yield* HttpClientResponse.schemaBodyJson(IssuesPage)(response).pipe(
		Effect.mapError((cause) => new GithubError({message: `GET ${path}: ${cause.message}`})),
	);
	return page
		.filter((issue) => issue.pull_request === undefined)
		.map(
			(issue): OpenIssue => ({number: issue.number, title: issue.title, body: issue.body ?? ""}),
		);
});

const CreatedIssue = Schema.Struct({number: Schema.Int, html_url: Schema.String});

export const fileIssue = Effect.fn("Github.fileIssue")(function* (
	target: GithubTarget,
	issue: IssueText,
) {
	const path = `repos/${target.repo}/issues`;
	const response = yield* request(target, "POST", path, {...issue, labels: [TRIAGE_LABEL]});
	return yield* HttpClientResponse.schemaBodyJson(CreatedIssue)(response).pipe(
		Effect.mapError((cause) => new GithubError({message: `POST ${path}: ${cause.message}`})),
	);
});

export const updateIssue = Effect.fn("Github.updateIssue")(function* (
	target: GithubTarget,
	issueNumber: number,
	issue: IssueText,
) {
	const path = `repos/${target.repo}/issues/${issueNumber}`;
	const response = yield* request(target, "PATCH", path, {...issue});
	return yield* HttpClientResponse.schemaBodyJson(CreatedIssue)(response).pipe(
		Effect.mapError((cause) => new GithubError({message: `PATCH ${path}: ${cause.message}`})),
	);
});
