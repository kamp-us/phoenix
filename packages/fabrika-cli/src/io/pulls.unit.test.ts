/** The pull-request adapter over the fetch client: the closing-issue edge, and every refusal. */
import {Effect, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import {fakeHttp, fakeShell, type HttpReply, linkNext, once} from "../fakes.test-support.ts";
import {
	getPullDiff,
	getPullRequest,
	listPullFiles,
	openPullsClosing,
	patchComment,
	permissionFor,
} from "./pulls.ts";

/** The credential comes off the environment, so a scripted request never depends on a `gh` spawn. */
beforeAll(() => {
	process.env.GITHUB_TOKEN = "ghp_scripted";
});

const GRAPHQL = /POST https:\/\/api\.github\.com\/graphql$/;

const served = (status: number, body: unknown, headers?: Record<string, string>): HttpReply => ({
	status,
	body: JSON.stringify(body),
	headers,
});

const wired = (script: ReadonlyArray<readonly [RegExp, HttpReply]>) => {
	const http = fakeHttp(script);
	return {http, layer: Layer.merge(http.layer, fakeShell([]).layer)};
};

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

const page = (nodes: ReadonlyArray<Node>, endCursor: string | null = null): HttpReply =>
	served(200, {
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
	});

const run = (script: ReadonlyArray<readonly [RegExp, HttpReply]>, issue = 5751) => {
	const {http, layer} = wired(script);
	return Effect.runPromise(Effect.provide(openPullsClosing("kamp-us/phoenix", issue), layer)).then(
		(result) => ({result, http}),
	);
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
		const {http} = await run([[GRAPHQL, page([pr(5803)])]]);

		expect(http.bodies[0]).toContain("closedByPullRequestsReferences");
		expect(http.bodies[0]).not.toContain("in:body");
		expect(http.calls[0]).not.toContain("search/issues");
	});

	it("pages — a second page's closers are not dropped, and it carries the cursor", async () => {
		const {http, layer} = wired([
			[once(GRAPHQL), page([pr(5803)], "cursor-1")],
			[GRAPHQL, page([pr(5804)])],
		]);
		const result = await Effect.runPromise(
			Effect.provide(openPullsClosing("kamp-us/phoenix", 5751), layer),
		);

		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{number: 5803, url: "https://github.com/kamp-us/phoenix/pull/5803"},
				{number: 5804, url: "https://github.com/kamp-us/phoenix/pull/5804"},
			],
		});
		expect(http.bodies[1]).toContain("cursor-1");
	});

	it("refuses when another page is declared with no cursor to fetch it", async () => {
		const {result} = await run([[GRAPHQL, page([pr(5803)], "")]]);

		expect(result._tag).toBe("Failure");
	});

	it("refuses when GitHub does not serve the query", async () => {
		const {result} = await run([[GRAPHQL, served(502, {message: "Bad gateway"})]]);

		expect(result._tag).toBe("Failure");
	});

	it("refuses a 200 that carries GraphQL errors rather than a page", async () => {
		const {result} = await run([[GRAPHQL, served(200, {errors: [{message: "nope"}]})]]);

		expect(result._tag).toBe("Failure");
	});

	it("refuses a 200 whose output is not a closing-pull page", async () => {
		const {result} = await run([[GRAPHQL, served(200, {data: {repository: {issue: null}}})]]);

		expect(result._tag).toBe("Failure");
	});

	it("refuses a node that is not a pull request rather than shortening the list", async () => {
		const {result} = await run([
			[GRAPHQL, page([{number: 5803, url: "", state: "OPEN"}] as ReadonlyArray<Node>)],
		]);

		expect(result._tag).toBe("Failure");
	});

	it("refuses a repo that is not owner/name", async () => {
		const {http, layer} = wired([[GRAPHQL, page([pr(5803)])]]);
		const result = await Effect.runPromise(
			Effect.provide(openPullsClosing("phoenix", 5751), layer),
		);

		expect(result._tag).toBe("Failure");
		expect(http.calls).toEqual([]);
	});
});

describe("getPullRequest — three arms, never two", () => {
	const record = {
		number: 4318,
		state: "open",
		head: {sha: "abc"},
		base: {ref: "main"},
		changed_files: 2,
	};

	it("reads a served pull request", async () => {
		const {layer} = wired([[/pulls\/4318/, served(200, record)]]);
		const result = await Effect.runPromise(
			Effect.provide(getPullRequest("kamp-us/phoenix", 4318), layer),
		);
		expect(result._tag).toBe("Present");
		expect(result._tag === "Present" && result.value.headSha).toBe("abc");
	});

	it("splits a 404 into Absent and anything else unreadable into Unknown", async () => {
		const absent = wired([[/pulls/, served(404, {message: "Not Found"})]]);
		const unreadable = wired([[/pulls/, served(502, {message: "Bad gateway"})]]);

		expect(
			await Effect.runPromise(Effect.provide(getPullRequest("kamp-us/phoenix", 1), absent.layer)),
		).toEqual({_tag: "Absent"});
		expect(
			(
				await Effect.runPromise(
					Effect.provide(getPullRequest("kamp-us/phoenix", 1), unreadable.layer),
				)
			)._tag,
		).toBe("Unknown");
	});

	it("reads a 200 of the wrong shape as Unknown, never as a pull request", async () => {
		const {layer} = wired([[/pulls/, served(200, {message: "Not Found"})]]);
		const result = await Effect.runPromise(
			Effect.provide(getPullRequest("kamp-us/phoenix", 1), layer),
		);
		expect(result._tag).toBe("Unknown");
	});
});

describe("permissionFor", () => {
	it("keeps a 404 a proven Absent — a non-collaborator holds no permission", async () => {
		const {layer} = wired([[/collaborators/, served(404, {message: "Not Found"})]]);
		const result = await Effect.runPromise(
			Effect.provide(permissionFor("kamp-us/phoenix", "someone"), layer),
		);
		expect(result).toEqual({_tag: "Absent"});
	});

	it("reads the permission a collaborator holds", async () => {
		const {layer} = wired([[/collaborators/, served(200, {permission: "write"})]]);
		const result = await Effect.runPromise(
			Effect.provide(permissionFor("kamp-us/phoenix", "someone"), layer),
		);
		expect(result).toEqual({_tag: "Present", value: "write"});
	});
});

describe("getPullDiff", () => {
	it("asks for the diff media type and hands back the text, unparsed", async () => {
		const diff = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";
		const {http, layer} = wired([[/pulls\/4318/, {status: 200, body: diff}]]);
		const result = await Effect.runPromise(
			Effect.provide(getPullDiff("kamp-us/phoenix", 4318), layer),
		);
		expect(result).toEqual({_tag: "Ok", value: diff});
		expect(http.calls[0]).toBe("GET https://api.github.com/repos/kamp-us/phoenix/pulls/4318");
		expect(http.headers[0]?.accept).toBe("application/vnd.github.diff");
	});

	it("refuses a diff GitHub did not serve", async () => {
		const {layer} = wired([[/pulls/, served(404, {message: "Not Found"})]]);
		const result = await Effect.runPromise(
			Effect.provide(getPullDiff("kamp-us/phoenix", 1), layer),
		);
		expect(result._tag).toBe("Failure");
	});
});

describe("listPullFiles", () => {
	it("pages the changed-file list", async () => {
		const {layer} = wired([
			[/&page=1$/, served(200, [{filename: "a.ts"}], linkNext("https://api.github.com/x?page=2"))],
			[/&page=2$/, served(200, [{filename: "b.ts"}])],
		]);
		const result = await Effect.runPromise(
			Effect.provide(listPullFiles("kamp-us/phoenix", 4318), layer),
		);
		expect(result).toEqual({_tag: "Ok", value: ["a.ts", "b.ts"]});
	});

	it("refuses an entry that is not a changed file rather than shortening the list", async () => {
		const {layer} = wired([[/files/, served(200, [{sha: "abc"}])]]);
		const result = await Effect.runPromise(
			Effect.provide(listPullFiles("kamp-us/phoenix", 4318), layer),
		);
		expect(result._tag).toBe("Failure");
	});
});

describe("patchComment", () => {
	it("sends the new body and reads back the edited comment's link", async () => {
		const {http, layer} = wired([
			[/issues\/comments\/99/, served(200, {html_url: "https://github.com/c/99"})],
		]);
		const result = await Effect.runPromise(
			Effect.provide(patchComment("kamp-us/phoenix", 99, "new body"), layer),
		);
		expect(result).toEqual({_tag: "Ok", value: "https://github.com/c/99"});
		expect(http.calls[0]).toContain("PATCH");
		expect(http.bodies[0]).toContain("new body");
	});

	it("refuses a 200 that is not an edited comment", async () => {
		const {layer} = wired([[/comments/, served(200, {message: "ok?"})]]);
		const result = await Effect.runPromise(
			Effect.provide(patchComment("kamp-us/phoenix", 99, "new body"), layer),
		);
		expect(result._tag).toBe("Failure");
	});
});
