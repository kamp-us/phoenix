/**
 * One repository's issues served over both of GitHub's APIs: the batched GraphQL issue nodes and the
 * REST issue, edge and comment reads. Each request is logged as `graphql <kind> #a,#b…` or
 * `METHOD url`, so a test can count reads of each kind and see the order they were made in.
 */
import {fakeHttpBy, type HttpReply} from "../fakes.test-support.ts";

export interface FakeIssue {
	readonly open?: boolean;
	readonly parent?: number;
	/** The full edge lists; a GraphQL connection serves the first 100 and declares the rest. */
	readonly subIssues?: ReadonlyArray<number>;
	readonly blockedBy?: ReadonlyArray<number>;
	readonly blocking?: ReadonlyArray<number>;
	readonly comments?: ReadonlyArray<string>;
	/** A pull request: REST serves it with a `pull_request` key, GraphQL answers `NOT_FOUND`. */
	readonly pr?: boolean;
	/** How many comments the REST list serves on each of its reads, in turn; the last one repeats. */
	readonly listed?: ReadonlyArray<number>;
	/** An error GraphQL reports on this issue's node alone. */
	readonly nodeError?: string;
}

export interface FakeIssuesOptions {
	/** Every GraphQL request answers this status instead. */
	readonly graphqlStatus?: number;
}

const json = (status: number, body: unknown): HttpReply => ({status, body: JSON.stringify(body)});

const connection = (numbers: ReadonlyArray<number> = []) => ({
	totalCount: numbers.length,
	nodes: numbers.slice(0, 100).map((number) => ({number})),
});

const ALIAS = /i(\d+):issue\(number:(\d+)\)/g;

export const fakeIssues = (
	issues: Readonly<Record<number, FakeIssue>>,
	options: FakeIssuesOptions = {},
) => {
	const log: string[] = [];
	const listReads = new Map<number, number>();
	const graphql = (body: string): HttpReply => {
		const {query} = JSON.parse(body) as {query: string};
		const numbers = [...query.matchAll(ALIAS)].map((match) => Number(match[2]));
		const kind = query.includes("subIssues") ? "nodes" : "counts";
		log.push(`graphql ${kind} ${numbers.map((n) => `#${n}`).join(",")}`);
		if (options.graphqlStatus !== undefined) {
			return json(options.graphqlStatus, {message: "Server Error"});
		}
		const repository: Record<string, unknown> = {};
		const errors: unknown[] = [];
		for (const number of numbers) {
			const issue = issues[number];
			const key = `i${number}`;
			if (issue === undefined || issue.pr === true) {
				repository[key] = null;
				errors.push({
					type: "NOT_FOUND",
					path: ["repository", key],
					message: `Could not resolve to an Issue with the number of ${number}.`,
				});
				continue;
			}
			if (issue.nodeError !== undefined) {
				repository[key] = null;
				errors.push({type: "FORBIDDEN", path: ["repository", key], message: issue.nodeError});
				continue;
			}
			repository[key] = {
				number,
				state: issue.open === false ? "CLOSED" : "OPEN",
				parent: issue.parent === undefined ? null : {number: issue.parent},
				...(kind === "nodes"
					? {
							subIssues: connection(issue.subIssues),
							blockedBy: connection(issue.blockedBy),
							blocking: connection(issue.blocking),
						}
					: {}),
				comments: {totalCount: issue.comments?.length ?? 0},
			};
		}
		return json(200, {data: {repository}, ...(errors.length > 0 ? {errors} : {})});
	};
	const rest = (path: string): HttpReply => {
		const edges =
			/\/issues\/(\d+)\/(sub_issues|dependencies\/blocked_by|dependencies\/blocking)/.exec(path);
		if (edges !== null) {
			const issue = issues[Number(edges[1])];
			if (issue === undefined || issue.pr === true) return json(404, {message: "Not Found"});
			const list =
				edges[2] === "sub_issues"
					? issue.subIssues
					: edges[2] === "dependencies/blocked_by"
						? issue.blockedBy
						: issue.blocking;
			return json(
				200,
				(list ?? []).map((number) => ({number})),
			);
		}
		const comments = /\/issues\/(\d+)\/comments/.exec(path);
		if (comments !== null) {
			const number = Number(comments[1]);
			const issue = issues[number];
			if (issue === undefined) return json(404, {message: "Not Found"});
			const read = listReads.get(number) ?? 0;
			listReads.set(number, read + 1);
			const all = issue.comments ?? [];
			const served = issue.listed?.[Math.min(read, (issue.listed?.length ?? 1) - 1)] ?? all.length;
			return json(
				200,
				all.slice(0, served).map((body, index) => ({
					id: number * 1000 + index,
					body,
					user: {login: "someone"},
				})),
			);
		}
		const single = /\/issues\/(\d+)(\?|$)/.exec(path);
		if (single !== null) {
			const number = Number(single[1]);
			const issue = issues[number];
			if (issue === undefined) return json(404, {message: "Not Found"});
			return json(200, {
				number,
				title: `Issue ${number}`,
				body: "",
				state: issue.open === false ? "closed" : "open",
				labels: [],
				html_url: `https://example.test/issues/${number}`,
				comments: issue.comments?.length ?? 0,
				...(issue.pr === true ? {pull_request: {}} : {}),
				...(issue.parent === undefined ? {} : {parent: {number: issue.parent}}),
			});
		}
		return json(500, {message: "unscripted request"});
	};
	const http = fakeHttpBy((line, body) => {
		if (/^POST https:\/\/api\.github\.com\/graphql$/.test(line)) return graphql(body);
		log.push(line);
		return rest(line);
	});
	/** How many logged requests match `pattern`. */
	const count = (pattern: RegExp): number => log.filter((line) => pattern.test(line)).length;
	return {layer: http.layer, log, count};
};

/** A REST read of one whole issue, never its comments or edges. */
export const REST_ISSUE = /^GET \S+\/issues\/\d+(\?\S*)?$/;
/** A REST read of one of an issue's edge lists. */
export const REST_EDGES = /^GET \S+\/issues\/\d+\/(sub_issues|dependencies\/)/;
/** A REST read of one issue's comment list. */
export const REST_COMMENTS = /^GET \S+\/issues\/\d+\/comments/;
/** One batched GraphQL request, either kind. */
export const GRAPHQL = /^graphql /;
