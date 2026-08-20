import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect, Layer} from "effect";
import {afterEach, describe, expect, it, vi} from "vitest";
import {fakeHttp, fakeShell, type HttpReply, linkNext, okOut} from "../fakes.test-support.ts";
import {NO_TOKEN, PAGE_CAP} from "../io/gh-api.ts";
import type {Attempt, Shell} from "../io/git.ts";
import {
	armAutoMerge,
	disableAutoMerge,
	fetchManifest,
	listReviews,
	listReviewThreads,
	listShipCheckRuns,
	listTeamMembers,
	listWorkflowPaths,
	pagedEnvelope,
	pagedWithLinkProof,
	pullTimeline,
	readFileAtRef,
	setPullState,
} from "./github.ts";

/** Every leg needs a spawner in context for the token's `gh auth token` arm; none of these use it. */
const noGh = fakeShell([], undefined, [/^gh /]);

const run = <A>(effect: Shell<A>, http: ReturnType<typeof fakeHttp>): Promise<A> =>
	Effect.runPromise(Effect.provide(effect, Layer.merge(noGh.layer, http.layer)));

/** Narrow an `Attempt` at the assertion site, so a test reads the value it says it read. */
const value = <A>(read: Attempt<A>): A => {
	if (read._tag !== "Ok") throw new Error(`expected Ok, got Failure: ${read.reason}`);
	return read.value;
};

const reason = <A>(read: Attempt<A>): string => {
	if (read._tag !== "Failure") throw new Error("expected Failure, got Ok");
	return read.reason;
};

const json = (value: unknown, headers?: Record<string, string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(value),
	...(headers === undefined ? {} : {headers}),
});

const review = (state: string) => ({
	state,
	user: {login: "cansirin"},
	commit_id: "abc",
	submitted_at: "2026-01-01T00:00:00Z",
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the Link-header proof", () => {
	it('is exhausted only on a terminal page carrying no `rel="next"`', async () => {
		const http = fakeHttp([[/reviews\?per_page=100&page=1/, json([review("APPROVED")])]]);
		const read = value(await run(listReviews("o/r", 4321), http));
		expect(read.exhausted).toBe(true);
		expect(read.reviews).toHaveLength(1);
		expect(http.calls).toEqual([
			"GET https://api.github.com/repos/o/r/pulls/4321/reviews?per_page=100&page=1",
		]);
	});

	it("walks to the next page and joins it, un-reduced", async () => {
		const http = fakeHttp([
			[/&page=1$/, json([review("APPROVED")], linkNext("https://api.github.com/x?page=2"))],
			[/&page=2$/, json([review("CHANGES_REQUESTED")])],
		]);
		const read = value(await run(listReviews("o/r", 4321), http));
		expect(read.exhausted).toBe(true);
		expect(read.reviews.map((r) => r.state)).toEqual(["APPROVED", "CHANGES_REQUESTED"]);
	});

	it(`reports exhausted: false once ${PAGE_CAP} pages still declare a next`, async () => {
		const http = fakeHttp([[/timeline/, json([], linkNext("https://api.github.com/x?page=2"))]]);
		const read = value(await run(pullTimeline("o/r", 4321), http));
		expect(read.exhausted).toBe(false);
		expect(http.calls).toHaveLength(PAGE_CAP);
	});

	it("holds the cap at 50 — the number the callers' refusal is written against", () => {
		expect(PAGE_CAP).toBe(50);
	});

	it("stays exported at its `gh`-era signature for `../heal-ci/github.ts`", async () => {
		const http = fakeHttp([[/rules\/branches\/main/, json([{type: "merge_queue"}])]]);
		const read = value(await run(pagedWithLinkProof("repos/o/r/rules/branches/main"), http));
		expect(read.entries).toEqual([{type: "merge_queue"}]);
		expect(read.exhausted).toBe(true);
	});
});

describe("the envelope proof", () => {
	it("hands back page one's total_count beside the entries", async () => {
		const http = fakeHttp([
			[
				/check-runs\?per_page=100&page=1$/,
				json(
					{total_count: 3, check_runs: [{name: "ci", status: "completed", id: 1}]},
					linkNext("https://api.github.com/x?page=2"),
				),
			],
			[
				/&page=2$/,
				json({total_count: 3, check_runs: [{name: "lint", status: "completed", id: 2}]}),
			],
		]);
		const read = value(await run(listShipCheckRuns("o/r", "abc"), http));
		expect(read.declared).toBe(3);
		expect(read.runs).toHaveLength(2);
	});

	it("refuses an envelope that declares no total_count rather than inventing one", async () => {
		const http = fakeHttp([[/check-runs/, json({check_runs: []})]]);
		const read = await run(listShipCheckRuns("o/r", "abc"), http);
		expect(reason(read)).toContain("total_count");
	});

	it("stays exported as the pure reader `../heal-ci/github.ts` still calls", () => {
		const read = pagedEnvelope('{"total_count":2,"jobs":[{"id":1}]}', "jobs");
		expect(read).toEqual({_tag: "Ok", value: {declared: 2, entries: [{id: 1}]}});
	});

	it("carries #6602's gap across the port: listWorkflowPaths still drops the declared count", async () => {
		const http = fakeHttp([
			[
				/actions\/workflows\?/,
				json({total_count: 9, workflows: [{state: "active", path: ".github/workflows/ci.yml"}]}),
			],
		]);
		const read = await run(listWorkflowPaths("o/r"), http);
		expect(read).toEqual({_tag: "Ok", value: [".github/workflows/ci.yml"]});
	});
});

describe("absence stays a proven answer, never a failed read", () => {
	it("reads a 404 CODEOWNERS as Absent and a 500 as Unknown", async () => {
		const missing = fakeHttp([[/contents/, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect((await run(readFileAtRef("o/r", ".github/CODEOWNERS", "main"), missing))._tag).toBe(
			"Absent",
		);
		const broken = fakeHttp([[/contents/, {status: 500, body: "{}"}]]);
		expect((await run(readFileAtRef("o/r", ".github/CODEOWNERS", "main"), broken))._tag).toBe(
			"Unknown",
		);
	});

	it("serves the raw bytes through the raw media type, not a JSON envelope", async () => {
		const http = fakeHttp([[/contents/, {status: 200, body: "* @kamp-us/core\n"}]]);
		const read = await run(readFileAtRef("o/r", ".github/CODEOWNERS", "main"), http);
		expect(read).toEqual({_tag: "Present", value: "* @kamp-us/core\n"});
	});

	it("reads a 404 team as Absent — the team does not exist in this org", async () => {
		const http = fakeHttp([[/teams/, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect((await run(listTeamMembers("kamp-us", "core"), http))._tag).toBe("Absent");
	});

	it("pages a present team and hands back every login", async () => {
		const http = fakeHttp([
			[/members\?per_page=100&page=1$/, json([{login: "a"}], linkNext("https://x/?page=2"))],
			[/&page=2$/, json([{login: "b"}])],
		]);
		const read = await run(listTeamMembers("kamp-us", "core"), http);
		expect(read).toEqual({_tag: "Present", value: ["a", "b"]});
	});
});

describe("the review-thread block", () => {
	const threadPage = (
		nodes: ReadonlyArray<unknown>,
		pageInfo: {hasNextPage: boolean; endCursor: string},
		totalCount = 2,
	) => json({data: {repository: {pullRequest: {reviewThreads: {totalCount, pageInfo, nodes}}}}});

	const thread = (id: string, comments: number) => ({
		id,
		isResolved: false,
		path: "src/a.ts",
		line: 3,
		comments: {
			totalCount: comments,
			nodes: [{body: "hi", author: {login: "bot", __typename: "Bot"}}],
		},
	});

	it("pages threads by cursor and keeps both counts", async () => {
		const http = fakeHttp([
			[/graphql/, threadPage([thread("t1", 4)], {hasNextPage: true, endCursor: "c1"})],
		]);
		// The scripted reply always declares a next page, so the read stops at its own 50-page bound.
		const read = value(await run(listReviewThreads("o/r", 4321), http));
		expect(read.declared).toBe(2);
		expect(read.threads[0]?.declaredComments).toBe(4);
		expect(http.calls.every((line) => line === "POST https://api.github.com/graphql")).toBe(true);
		expect(http.bodies[1]).toContain('"cursor":"c1"');
	});

	it("refuses a page that declared another and named no cursor", async () => {
		const http = fakeHttp([
			[/graphql/, threadPage([thread("t1", 1)], {hasNextPage: true, endCursor: ""})],
		]);
		expect(reason(await run(listReviewThreads("o/r", 4321), http))).toContain("named no cursor");
	});

	it("refuses the endpoint's own errors array rather than reading past it", async () => {
		const http = fakeHttp([
			[/graphql/, json({errors: [{message: "Could not resolve to a node"}]})],
		]);
		expect(reason(await run(listReviewThreads("o/r", 4321), http))).toContain(
			"Could not resolve to a node",
		);
	});
});

describe("the auto-merge mutations", () => {
	const armed = json({
		data: {
			repository: {pullRequest: {id: "PR_node"}},
			enablePullRequestAutoMerge: {clientMutationId: null},
			disablePullRequestAutoMerge: {clientMutationId: null},
		},
	});

	it("arms through enablePullRequestAutoMerge and passes NO merge method", async () => {
		const http = fakeHttp([[/graphql/, armed]]);
		expect(await run(armAutoMerge("o/r", 4321), http)).toEqual({_tag: "Ok", value: undefined});
		expect(http.bodies[0]).toContain("pullRequest(number:$number){id}");
		expect(http.bodies[1]).toContain("enablePullRequestAutoMerge");
		expect(http.bodies.join("")).not.toContain("mergeMethod");
	});

	it("clears through disablePullRequestAutoMerge", async () => {
		const http = fakeHttp([[/graphql/, armed]]);
		expect(await run(disableAutoMerge("o/r", 4321), http)).toEqual({_tag: "Ok", value: undefined});
		expect(http.bodies[1]).toContain("disablePullRequestAutoMerge");
	});

	it("refuses when the PR has no node id rather than arming nothing at exit 0", async () => {
		const http = fakeHttp([[/graphql/, json({data: {repository: {pullRequest: null}}})]]);
		expect(reason(await run(armAutoMerge("o/r", 4321), http))).toContain("no node id");
	});
});

describe("setPullState", () => {
	it("PATCHes the state and reads the status back", async () => {
		const http = fakeHttp([[/PATCH/, json({state: "closed"})]]);
		expect(await run(setPullState("o/r", 4321, "closed"), http)).toEqual({
			_tag: "Ok",
			value: undefined,
		});
		expect(http.calls).toEqual(["PATCH https://api.github.com/repos/o/r/pulls/4321"]);
		expect(http.bodies[0]).toBe('{"state":"closed"}');
	});

	it("is a failure on a non-2xx — the caller re-reads, and must not read a refusal as done", async () => {
		const http = fakeHttp([[/PATCH/, {status: 422, body: "{}"}]]);
		expect(reason(await run(setPullState("o/r", 4321, "open"), http))).toContain("422");
	});
});

describe("fetchManifest", () => {
	const scratch = () => mkdtempSync(join(tmpdir(), "fabrika-manifest-"));

	const withUnzip = (payload: string) =>
		fakeShell([[/^sh -c unzip -p /, okOut(payload)]], undefined, [/^gh /]);

	const fetchWith = (http: ReturnType<typeof fakeHttp>, shell: ReturnType<typeof fakeShell>) =>
		Effect.runPromise(
			Effect.provide(fetchManifest("o/r", 77, scratch()), Layer.merge(shell.layer, http.layer)),
		);

	it("serves the manifest once the bytes carry the PK magic number", async () => {
		const http = fakeHttp([[/artifacts\/77\/zip/, {status: 200, body: "PKrest"}]]);
		const read = await fetchWith(http, withUnzip('{"captures":[]}'));
		expect(read).toEqual({_tag: "Ok", value: '{"captures":[]}'});
	});

	it("refuses bytes that are not a zip — a 503 body saved as .zip is not a bundle (#3716)", async () => {
		const http = fakeHttp([[/zip/, {status: 200, body: "<html>502 Bad Gateway</html>"}]]);
		expect(reason(await fetchWith(http, withUnzip("never read")))).toContain("not a zip");
	});

	it("refuses a non-2xx download before it ever looks at the bytes", async () => {
		const http = fakeHttp([[/zip/, {status: 410, body: "PK gone"}]]);
		expect(reason(await fetchWith(http, withUnzip("never read")))).toContain("410");
	});
});

describe("the credential", () => {
	it("refuses naming both env vars rather than issuing an anonymous request", async () => {
		vi.stubEnv("GITHUB_TOKEN", "");
		vi.stubEnv("GH_TOKEN", "");
		const http = fakeHttp([]);
		const read = await run(listReviews("o/r", 4321), http);
		expect(read).toEqual({_tag: "Failure", reason: NO_TOKEN});
		expect(http.calls).toEqual([]);
	});

	it("is Unknown, never Absent, on an existence read it could not authenticate", async () => {
		vi.stubEnv("GITHUB_TOKEN", "");
		vi.stubEnv("GH_TOKEN", "");
		const http = fakeHttp([]);
		const read = await run(readFileAtRef("o/r", ".github/CODEOWNERS", "main"), http);
		expect(read._tag).toBe("Unknown");
		expect(http.calls).toEqual([]);
	});
});
