/** `openPullsClosing` — the closing-issue link edge, and every shape it refuses to read. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "./exec.ts";
import {openPullsClosing} from "./pulls.ts";

const GRAPHQL = /^gh api graphql /;

interface Node {
	readonly number: number;
	readonly url: string;
	readonly state: string;
}

const pr = (number: number, state = "OPEN"): Node => ({
	number,
	url: `https://github.com/kamp-us/phoenix/pull/${number}`,
	state,
});

const page = (nodes: ReadonlyArray<Node>, endCursor: string | null = null): ExecResult =>
	okOut(
		JSON.stringify({
			data: {
				repository: {
					issue: {
						closedByPullRequestsReferences: {
							pageInfo: {hasNextPage: endCursor !== null, endCursor},
							nodes,
						},
					},
				},
			},
		}),
	);

const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]>, issue = 5751) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(openPullsClosing("kamp-us/phoenix", issue), shell.layer),
	).then((result) => ({result, calls: shell.calls}));
};

describe("openPullsClosing", () => {
	it("returns the one PR declaring it closes the issue", async () => {
		const {result} = await run([[GRAPHQL, page([pr(5803)])]]);

		expect(result).toEqual({
			_tag: "Ok",
			value: [{number: 5803, url: "https://github.com/kamp-us/phoenix/pull/5803"}],
		});
	});

	it("reads zero closers as an empty FACT, not a failure — the caller owns that park", async () => {
		const {result} = await run([[GRAPHQL, page([])]]);

		expect(result).toEqual({_tag: "Ok", value: []});
	});

	it("returns both when two PRs genuinely declare they close the same issue", async () => {
		const {result} = await run([[GRAPHQL, page([pr(5803), pr(5804)])]]);

		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{number: 5803, url: "https://github.com/kamp-us/phoenix/pull/5803"},
				{number: 5804, url: "https://github.com/kamp-us/phoenix/pull/5804"},
			],
		});
	});

	it("drops a closer that is no longer open — the caller asked about open PRs", async () => {
		const {result} = await run([
			[GRAPHQL, page([pr(5788, "MERGED"), pr(5803), pr(5799, "CLOSED")])],
		]);

		expect(result).toEqual({
			_tag: "Ok",
			value: [{number: 5803, url: "https://github.com/kamp-us/phoenix/pull/5803"}],
		});
	});

	it("asks the closing-issue edge, never a free-text body search (#5805)", async () => {
		const {calls} = await run([[GRAPHQL, page([pr(5803)])]]);

		expect(calls[0]).toContain("closedByPullRequestsReferences");
		expect(calls[0]).not.toContain("in:body");
		expect(calls[0]).not.toContain("search/issues");
	});

	it("pages — a second page's closers are not dropped", async () => {
		const {result} = await run([
			[once(GRAPHQL), page([pr(5803)], "cursor-1")],
			[GRAPHQL, page([pr(5804)])],
		]);

		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{number: 5803, url: "https://github.com/kamp-us/phoenix/pull/5803"},
				{number: 5804, url: "https://github.com/kamp-us/phoenix/pull/5804"},
			],
		});
	});

	it("refuses when another page is declared with no cursor to fetch it", async () => {
		const {result} = await run([[GRAPHQL, page([pr(5803)], "")]]);

		expect(result._tag).toBe("Failure");
	});

	it("refuses when gh fails", async () => {
		const {result} = await run([[GRAPHQL, errOut("HTTP 502")]]);

		expect(result._tag).toBe("Failure");
	});

	it("refuses a 0 exit whose output is not a closing-pull page", async () => {
		const {result} = await run([[GRAPHQL, okOut('{"data":{"repository":{"issue":null}}}')]]);

		expect(result._tag).toBe("Failure");
	});

	it("refuses a node that is not a pull request rather than shortening the list", async () => {
		const {result} = await run([
			[GRAPHQL, page([{number: 5803, url: "", state: "OPEN"}] as ReadonlyArray<Node>)],
		]);

		expect(result._tag).toBe("Failure");
	});

	it("refuses a repo that is not owner/name", async () => {
		const shell = fakeShell([[GRAPHQL, page([pr(5803)])]]);
		const result = await Effect.runPromise(
			Effect.provide(openPullsClosing("phoenix", 5751), shell.layer),
		);

		expect(result._tag).toBe("Failure");
		expect(shell.calls).toEqual([]);
	});
});
