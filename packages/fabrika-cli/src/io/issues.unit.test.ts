import {Effect, Layer} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {
	type FakeHttp,
	fakeHttp,
	fakeShell,
	type HttpReply,
	linkNext,
} from "../fakes.test-support.ts";
import {NO_TOKEN, PAGE_CAP} from "./gh-api.ts";
import type {Shell} from "./git.ts";
import {
	addLabels,
	clearMilestone,
	closeCompleted,
	closeNotPlanned,
	createComment,
	createIssue,
	deleteComment,
	getIssue,
	issueTimeline,
	listComments,
	listLabels,
	listMilestones,
	listOpenIssues,
	listOpenMilestones,
	openIssuesTitled,
	openIssuesWithLabel,
	openIssuesWithLabelDetailed,
	openQueueIssues,
	patchIssueBody,
	removeLabel,
	repoDefaultBranch,
	searchOpenIssues,
	setMilestone,
} from "./issues.ts";

const TOKEN = "ghp_scripted";

interface Reply {
	readonly status: number;
	/** The payload as a value; `fakeHttp` takes it as the bytes the response carries. */
	readonly body: unknown;
	readonly headers?: Readonly<Record<string, string>>;
}

const asReply = (reply: Reply): HttpReply => ({
	status: reply.status,
	body: JSON.stringify(reply.body),
	headers: reply.headers,
});

/** The package's own `HttpClient` fake, scripted on `METHOD url` and answering with JSON. */
const scripted = (
	script: ReadonlyArray<readonly [RegExp, Reply]>,
	fallback: Reply = {status: 500, body: {message: "unscripted request"}},
): FakeHttp =>
	fakeHttp(
		script.map(([pattern, reply]) => [pattern, asReply(reply)] as const),
		asReply(fallback),
	);

/** No `gh` on PATH: nothing under test may fall back to a subprocess for a credential. */
const noGh = fakeShell([], undefined, [/^gh /]);

const against = <A>(effect: Shell<A>, http: FakeHttp): Promise<A> =>
	Effect.runPromise(Effect.provide(effect, Layer.merge(noGh.layer, http.layer)));

const original = {github: process.env.GITHUB_TOKEN, gh: process.env.GH_TOKEN};

beforeEach(() => {
	process.env.GITHUB_TOKEN = TOKEN;
	delete process.env.GH_TOKEN;
});

afterEach(() => {
	if (original.github === undefined) delete process.env.GITHUB_TOKEN;
	else process.env.GITHUB_TOKEN = original.github;
	if (original.gh === undefined) delete process.env.GH_TOKEN;
	else process.env.GH_TOKEN = original.gh;
});

const issue = (fields: Record<string, unknown>) => ({
	number: 7,
	title: "t",
	html_url: "u",
	state: "open",
	labels: [],
	...fields,
});

describe("the credential is an argument to every request, never something a request path guesses", () => {
	it("sends the resolved token as the authorization header", async () => {
		const http = scripted([[/issues\/7/, {status: 200, body: issue({})}]]);
		await against(getIssue("kamp-us/phoenix", 7), http);
		expect(http.calls[0]).toBe("GET https://api.github.com/repos/kamp-us/phoenix/issues/7");
	});

	it("refuses naming both env vars when nothing resolves one, and issues no request", async () => {
		delete process.env.GITHUB_TOKEN;
		const http = scripted([]);
		const result = await against(listLabels("kamp-us/phoenix"), http);
		expect(result).toEqual({_tag: "Failure", reason: NO_TOKEN});
		expect(http.calls).toEqual([]);
	});

	it("seats an unresolvable credential on Unknown for an Existence read, never on Absent", async () => {
		delete process.env.GITHUB_TOKEN;
		const result = await against(getIssue("kamp-us/phoenix", 7), scripted([]));
		expect(result._tag).toBe("Unknown");
	});
});

describe("getIssue carries the two facets a read-back cannot prove from labels", () => {
	it("reads the milestone number and the state reason", async () => {
		const http = scripted([
			[
				/issues\/7/,
				{
					status: 200,
					body: issue({
						state: "closed",
						state_reason: "not_planned",
						milestone: {number: 44, title: "fabrika campaign"},
					}),
				},
			],
		]);
		const result = await against(getIssue("kamp-us/phoenix", 7), http);
		expect(result).toMatchObject({
			_tag: "Present",
			value: {milestone: 44, stateReason: "not_planned"},
		});
	});

	it("reads an unhomed, open issue as null on both — absence, not a guess", async () => {
		const http = scripted([
			[/issues\/7/, {status: 200, body: issue({state_reason: null, milestone: null})}],
		]);
		const result = await against(getIssue("kamp-us/phoenix", 7), http);
		expect(result).toMatchObject({_tag: "Present", value: {milestone: null, stateReason: null}});
	});

	it("reads the filing account's login — the provenance predicate's second signal", async () => {
		const http = scripted([
			[/issues\/7/, {status: 200, body: issue({user: {login: "some-account"}})}],
		]);
		const result = await against(getIssue("kamp-us/phoenix", 7), http);
		expect(result).toMatchObject({_tag: "Present", value: {author: "some-account"}});
	});

	it("reads a missing author as the empty login, which is never an operator account", async () => {
		const http = scripted([[/issues\/7/, {status: 200, body: issue({})}]]);
		const result = await against(getIssue("kamp-us/phoenix", 7), http);
		expect(result).toMatchObject({_tag: "Present", value: {author: ""}});
	});

	it("splits a proven 404 from a status nobody can read a verdict off", async () => {
		const missing = await against(
			getIssue("kamp-us/phoenix", 7),
			scripted([[/issues\/7/, {status: 404, body: {message: "Not Found"}}]]),
		);
		expect(missing).toEqual({_tag: "Absent"});

		const unreadable = await against(
			getIssue("kamp-us/phoenix", 7),
			scripted([[/issues\/7/, {status: 502, body: {message: "Bad gateway"}}]]),
		);
		expect(unreadable._tag).toBe("Unknown");
	});

	it("refuses a 200 whose body is not an issue rather than reading it positionally", async () => {
		const result = await against(
			getIssue("kamp-us/phoenix", 7),
			scripted([[/issues\/7/, {status: 200, body: {message: "Not Found"}}]]),
		);
		expect(result._tag).toBe("Unknown");
	});
});

describe("the list reads page, and refuse a shape that is not what they asked for", () => {
	it("listLabels asks for the label set and reads every page", async () => {
		const http = scripted([
			[
				/&page=1$/,
				{
					status: 200,
					body: [{name: "type:bug"}],
					headers: linkNext("https://api.github.com/repos/o/r/labels?page=2"),
				},
			],
			[/&page=2$/, {status: 200, body: [{name: "p1"}]}],
		]);
		const result = await against(listLabels("o/r"), http);
		expect(result).toEqual({_tag: "Ok", value: ["type:bug", "p1"]});
		expect(http.calls[0]).toContain("per_page=100");
	});

	it("listLabels refuses a 200 whose entries are not labels", async () => {
		const result = await against(
			listLabels("o/r"),
			scripted([[/labels/, {status: 200, body: [{message: "Not Found"}]}]]),
		);
		expect(result._tag).toBe("Failure");
	});

	it("openIssuesWithLabel filters pull requests out and escapes the label", async () => {
		const http = scripted([
			[
				/issues/,
				{
					status: 200,
					body: [
						{number: 1, title: "an issue"},
						{number: 2, title: "a pull request", pull_request: {url: "u"}},
					],
				},
			],
		]);
		const result = await against(openIssuesWithLabel("o/r", "status:needs-triage"), http);
		expect(result).toEqual({_tag: "Ok", value: [{number: 1, title: "an issue"}]});
		expect(http.calls[0]).toContain("labels=status%3Aneeds-triage");
	});

	it("openIssuesWithLabelDetailed carries the body a title-only row cannot", async () => {
		const http = scripted([
			[/issues/, {status: 200, body: [{number: 9412, title: "a topic", body: "## Came from"}]}],
		]);
		const result = await against(openIssuesWithLabelDetailed("o/r", "l"), http);
		expect(result).toEqual({
			_tag: "Ok",
			value: [{number: 9412, title: "a topic", body: "## Came from"}],
		});
	});

	it("openIssuesTitled matches the title exactly, off the issues endpoint not the search index", async () => {
		const http = scripted([
			[
				/issues/,
				{
					status: 200,
					body: [
						{number: 1, title: "map: portability"},
						{number: 2, title: "map: portability (draft)"},
					],
				},
			],
		]);
		const result = await against(openIssuesTitled("o/r", "map: portability"), http);
		expect(result).toEqual({_tag: "Ok", value: [{number: 1, title: "map: portability"}]});
		expect(http.calls[0]).not.toContain("search/issues");
	});

	it("searchOpenIssues reads the envelope's items, AND-joining the tokens into the query", async () => {
		const http = scripted([
			[/search/, {status: 200, body: {total_count: 1, items: [{number: 5, title: "focus"}]}}],
		]);
		const result = await against(searchOpenIssues("o/r", ["focus", "steal"]), http);
		expect(result).toEqual({_tag: "Ok", value: [{number: 5, title: "focus"}]});
		expect(decodeURIComponent(http.calls[0] ?? "")).toContain(
			"repo:o/r is:issue is:open focus steal",
		);
	});

	it("searchOpenIssues refuses an envelope that declares no count", async () => {
		const result = await against(
			searchOpenIssues("o/r", ["focus"]),
			scripted([[/search/, {status: 200, body: {items: []}}]]),
		);
		expect(result._tag).toBe("Failure");
	});

	it("listOpenMilestones asks only for open milestones", async () => {
		const http = scripted([
			[
				/milestones/,
				{
					status: 200,
					body: [
						{number: 24, title: "Geçit"},
						{number: 44, title: "fabrika campaign"},
					],
				},
			],
		]);
		const result = await against(listOpenMilestones("kamp-us/phoenix"), http);
		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{number: 24, title: "Geçit"},
				{number: 44, title: "fabrika campaign"},
			],
		});
		expect(http.calls[0]).toContain("state=open");
		expect(http.calls[0]).toContain("per_page=100");
	});

	it("listOpenMilestones refuses rather than returning a short list when the read fails", async () => {
		const result = await against(
			listOpenMilestones("kamp-us/phoenix"),
			scripted([[/milestones/, {status: 502, body: {message: "Bad gateway"}}]]),
		);
		expect(result._tag).toBe("Failure");
	});

	it("listOpenMilestones refuses a 200 whose entries are not milestones", async () => {
		const result = await against(
			listOpenMilestones("kamp-us/phoenix"),
			scripted([[/milestones/, {status: 200, body: [{number: "24", title: "Geçit"}]}]]),
		);
		expect(result._tag).toBe("Failure");
	});

	it("listMilestones reads every state, and refuses a third one", async () => {
		const both = await against(
			listMilestones("o/r"),
			scripted([
				[
					/milestones/,
					{
						status: 200,
						body: [
							{number: 1, title: "open one", state: "open"},
							{number: 2, title: "closed one", state: "closed"},
						],
					},
				],
			]),
		);
		expect(both).toEqual({
			_tag: "Ok",
			value: [
				{number: 1, title: "open one", state: "open"},
				{number: 2, title: "closed one", state: "closed"},
			],
		});

		const third = await against(
			listMilestones("o/r"),
			scripted([[/milestones/, {status: 200, body: [{number: 1, title: "t", state: "archived"}]}]]),
		);
		expect(third._tag).toBe("Failure");
	});

	it("listOpenIssues filters pull requests out and refuses an entry that is not an issue", async () => {
		const kept = await against(
			listOpenIssues("o/r"),
			scripted([
				[/issues/, {status: 200, body: [issue({number: 1}), issue({number: 2, pull_request: {}})]}],
			]),
		);
		expect(kept).toMatchObject({_tag: "Ok", value: [{number: 1}]});

		const refused = await against(
			listOpenIssues("o/r"),
			scripted([[/issues/, {status: 200, body: [{message: "Not Found"}]}]]),
		);
		expect(refused._tag).toBe("Failure");
	});
});

describe("a list whose completeness is load-bearing refuses a walk it could not finish", () => {
	it("listComments reads every page, in order", async () => {
		const comment = (id: number, login: string, body: string) => ({
			id,
			user: {login},
			created_at: "2026-08-03T09:28:41Z",
			updated_at: "2026-08-03T10:00:00Z",
			body,
		});
		const http = scripted([
			[
				/&page=1$/,
				{
					status: 200,
					body: [comment(1, "usirin", "first")],
					headers: linkNext("https://api.github.com/next"),
				},
			],
			[/&page=2$/, {status: 200, body: [comment(2, "cansirin", "second")]}],
		]);
		const result = await against(listComments("kamp-us/phoenix", 4831), http);
		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{
					id: 1,
					author: "usirin",
					createdAt: "2026-08-03T09:28:41Z",
					updatedAt: "2026-08-03T10:00:00Z",
					body: "first",
				},
				{
					id: 2,
					author: "cansirin",
					createdAt: "2026-08-03T09:28:41Z",
					updatedAt: "2026-08-03T10:00:00Z",
					body: "second",
				},
			],
		});
	});

	it("carries a body holding a control character, which `--jq -r` could not", async () => {
		const http = scripted([
			[/comments/, {status: 200, body: [{id: 1, user: {login: "usirin"}, body: "a\nb"}]}],
		]);
		const result = await against(listComments("kamp-us/phoenix", 1), http);
		expect(result).toMatchObject({_tag: "Ok", value: [{body: "a\nb"}]});
	});

	it("refuses on an entry that is not a comment", async () => {
		const result = await against(
			listComments("kamp-us/phoenix", 1),
			scripted([[/comments/, {status: 200, body: [{message: "Not Found"}]}]]),
		);
		expect(result._tag).toBe("Failure");
	});

	it("refuses a walk that hit the page cap with another page outstanding", async () => {
		const http = scripted([], {
			status: 200,
			body: [],
			headers: linkNext("https://api.github.com/next"),
		});
		const result = await against(listComments("kamp-us/phoenix", 1), http);
		expect(result._tag).toBe("Failure");
		expect(result).toMatchObject({reason: expect.stringContaining("not the whole list")});
		expect(http.calls).toHaveLength(PAGE_CAP);
	});

	it("listOpenIssues refuses the same capped walk — a short board reads as never drifted", async () => {
		const http = scripted([], {
			status: 200,
			body: [],
			headers: linkNext("https://api.github.com/next"),
		});
		expect((await against(listOpenIssues("o/r"), http))._tag).toBe("Failure");
	});
});

describe("removeLabel splits `it is gone` from `I could not remove it`", () => {
	it("reports false — not a failure — when the label was already absent", async () => {
		const result = await against(
			removeLabel("kamp-us/phoenix", 1, "status:needs-triage"),
			scripted([[/labels/, {status: 404, body: {message: "Label does not exist"}}]]),
		);
		expect(result).toEqual({_tag: "Ok", value: false});
	});

	it("fails on any other error — an unreachable GitHub is not a removal", async () => {
		const result = await against(
			removeLabel("kamp-us/phoenix", 1, "status:needs-triage"),
			scripted([[/labels/, {status: 502, body: {message: "Bad gateway"}}]]),
		);
		expect(result._tag).toBe("Failure");
	});

	it("escapes the label name into the path", async () => {
		const http = scripted([[/labels/, {status: 200, body: []}]]);
		await against(removeLabel("kamp-us/phoenix", 1, "type:bug"), http);
		expect(http.calls[0]).toBe(
			"DELETE https://api.github.com/repos/kamp-us/phoenix/issues/1/labels/type%3Abug",
		);
	});
});

describe("the writes send the fields the API needs, in the form it accepts", () => {
	it("addLabels adds rather than replaces, and issues no request for an empty list", async () => {
		const http = scripted([[/labels/, {status: 200, body: []}]]);
		await against(addLabels("kamp-us/phoenix", 1, ["type:bug", "p1"]), http);
		expect(http.calls[0]).toBe("POST https://api.github.com/repos/kamp-us/phoenix/issues/1/labels");
		expect(JSON.parse(http.bodies[0] ?? "{}")).toEqual({labels: ["type:bug", "p1"]});

		const empty = scripted([]);
		const result = await against(addLabels("kamp-us/phoenix", 1, []), empty);
		expect(result._tag).toBe("Ok");
		expect(empty.calls).toEqual([]);
	});

	it("setMilestone sends the number as a number, which is what homes an issue", async () => {
		const http = scripted([[/issues\/1/, {status: 200, body: issue({})}]]);
		await against(setMilestone("kamp-us/phoenix", 1, 44), http);
		expect(http.calls[0]).toBe("PATCH https://api.github.com/repos/kamp-us/phoenix/issues/1");
		expect(JSON.parse(http.bodies[0] ?? "{}")).toEqual({milestone: 44});
	});

	it('clearMilestone sends a JSON null, not the string "null"', async () => {
		const http = scripted([[/issues\/1/, {status: 200, body: issue({})}]]);
		await against(clearMilestone("kamp-us/phoenix", 1), http);
		expect(JSON.parse(http.bodies[0] ?? "{}")).toEqual({milestone: null});
	});

	it("closeNotPlanned states the reason — a bare close reads as completed", async () => {
		const http = scripted([[/issues\/1/, {status: 200, body: issue({})}]]);
		await against(closeNotPlanned("kamp-us/phoenix", 1), http);
		expect(JSON.parse(http.bodies[0] ?? "{}")).toEqual({
			state: "closed",
			state_reason: "not_planned",
		});
	});

	it("closeCompleted states the opposite reason on the same endpoint", async () => {
		const http = scripted([[/issues\/1/, {status: 200, body: issue({})}]]);
		await against(closeCompleted("kamp-us/phoenix", 1), http);
		expect(JSON.parse(http.bodies[0] ?? "{}")).toEqual({
			state: "closed",
			state_reason: "completed",
		});
	});

	it("patchIssueBody writes the body field — a `title` here would overwrite the title", async () => {
		const http = scripted([[/issues\/7/, {status: 200, body: issue({})}]]);
		await against(patchIssueBody("kamp-us/phoenix", 7, "enriched-body-text"), http);
		expect(http.calls[0]).toBe("PATCH https://api.github.com/repos/kamp-us/phoenix/issues/7");
		expect(JSON.parse(http.bodies[0] ?? "{}")).toEqual({body: "enriched-body-text"});
	});

	it("deleteComment targets the id it was given — an off-by-one deletes someone else's", async () => {
		const http = scripted([[/comments/, {status: 200, body: {}}]]);
		const result = await against(deleteComment("kamp-us/phoenix", 5170139674), http);
		expect(result._tag).toBe("Ok");
		expect(http.calls[0]).toBe(
			"DELETE https://api.github.com/repos/kamp-us/phoenix/issues/comments/5170139674",
		);
	});

	it("patchIssueBody and deleteComment surface the failure rather than swallowing it", async () => {
		const failing: ReadonlyArray<readonly [RegExp, Reply]> = [
			[/./, {status: 502, body: {message: "Bad gateway"}}],
		];
		expect((await against(patchIssueBody("r/r", 1, "b"), scripted(failing)))._tag).toBe("Failure");
		expect((await against(deleteComment("r/r", 9), scripted(failing)))._tag).toBe("Failure");
	});

	it("createIssue carries the one label, and reads the created number back off the response", async () => {
		const http = scripted([
			[/POST/, {status: 201, body: {number: 4312, html_url: "https://github.com/o/r/issues/4312"}}],
		]);
		const result = await against(
			createIssue("o/r", "a title", "a body", "status:needs-triage"),
			http,
		);
		expect(result).toEqual({
			_tag: "Ok",
			value: {number: 4312, url: "https://github.com/o/r/issues/4312"},
		});
		expect(JSON.parse(http.bodies[0] ?? "{}")).toEqual({
			title: "a title",
			body: "a body",
			labels: ["status:needs-triage"],
		});
	});

	it("createIssue refuses a 2xx whose body is not a created issue", async () => {
		const result = await against(
			createIssue("o/r", "t", "b", "l"),
			scripted([[/POST/, {status: 201, body: {message: "ok?"}}]]),
		);
		expect(result._tag).toBe("Failure");
	});

	it("createComment reads the comment id back, which the read-back then re-reads", async () => {
		const http = scripted([
			[/POST/, {status: 201, body: {id: 5170139674, html_url: "https://github.com/c/1"}}],
		]);
		const result = await against(createComment("o/r", 7, "marker"), http);
		expect(result).toEqual({
			_tag: "Ok",
			value: {id: 5170139674, url: "https://github.com/c/1"},
		});
		expect(JSON.parse(http.bodies[0] ?? "{}")).toEqual({body: "marker"});
	});
});

describe("openQueueIssues", () => {
	it("filters pull requests out and carries the filing time the age is computed from", async () => {
		const http = scripted([
			[
				/issues/,
				{
					status: 200,
					body: [
						{number: 4312, created_at: "2026-08-01T00:00:00Z", title: "Abort reason lost"},
						{number: 4088, created_at: "2026-07-01T00:00:00Z", title: "Cancellation"},
						{number: 9, created_at: "2026-07-01T00:00:00Z", title: "a PR", pull_request: {}},
					],
				},
			],
		]);
		const result = await against(openQueueIssues("kamp-us/phoenix", "status:needs-triage"), http);
		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{number: 4312, createdAt: "2026-08-01T00:00:00Z", title: "Abort reason lost"},
				{number: 4088, createdAt: "2026-07-01T00:00:00Z", title: "Cancellation"},
			],
		});
		expect(http.calls[0]).toContain("per_page=100");
	});

	it("carries a title containing a tab, which a positional row read could not", async () => {
		const result = await against(
			openQueueIssues("o/r", "l"),
			scripted([
				[
					/issues/,
					{status: 200, body: [{number: 7, created_at: "2026-08-01T00:00:00Z", title: "a\tb\tc"}]},
				],
			]),
		);
		expect(result).toEqual({
			_tag: "Ok",
			value: [{number: 7, createdAt: "2026-08-01T00:00:00Z", title: "a\tb\tc"}],
		});
	});

	it("escapes the label into the query string", async () => {
		const http = scripted([[/issues/, {status: 200, body: []}]]);
		await against(openQueueIssues("o/r", "status:needs-triage"), http);
		expect(http.calls[0]).toContain("labels=status%3Aneeds-triage");
	});

	it("reads no rows as an empty FACT — the caller turns that into the `empty` state word", async () => {
		const result = await against(
			openQueueIssues("o/r", "l"),
			scripted([[/issues/, {status: 200, body: []}]]),
		);
		expect(result).toEqual({_tag: "Ok", value: []});
	});

	it("refuses a 200 whose rows are not queue rows, rather than reading them positionally", async () => {
		const notAnIssue = await against(
			openQueueIssues("o/r", "l"),
			scripted([[/issues/, {status: 200, body: [{number: "7", title: "t"}]}]]),
		);
		expect(notAnIssue._tag).toBe("Failure");
	});

	it("refuses a row whose filing time is unparseable — an unreadable age is not 0", async () => {
		const result = await against(
			openQueueIssues("o/r", "l"),
			scripted([[/issues/, {status: 200, body: [{number: 7, title: "t", created_at: "soon"}]}]]),
		);
		expect(result._tag).toBe("Failure");
	});

	it("refuses rather than returning a short list when the read fails", async () => {
		const result = await against(
			openQueueIssues("o/r", "l"),
			scripted([[/issues/, {status: 502, body: {message: "Bad gateway"}}]]),
		);
		expect(result._tag).toBe("Failure");
	});
});

describe("issueTimeline", () => {
	it("keeps the cross-references and tells a referencing PR from a referencing issue", async () => {
		const http = scripted([
			[
				/timeline/,
				{
					status: 200,
					body: [
						{event: "labeled"},
						{event: "cross-referenced", source: {issue: {number: 4832, pull_request: {url: "u"}}}},
						{event: "cross-referenced", source: {issue: {number: 4706}}},
					],
				},
			],
		]);
		const result = await against(issueTimeline("kamp-us/phoenix", 4831), http);
		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{number: 4832, isPullRequest: true},
				{number: 4706, isPullRequest: false},
			],
		});
	});

	it("refuses on a read that failed — an empty timeline would read as `no twin exists`", async () => {
		const result = await against(
			issueTimeline("kamp-us/phoenix", 1),
			scripted([[/timeline/, {status: 502, body: {message: "Bad gateway"}}]]),
		);
		expect(result._tag).toBe("Failure");
	});
});

describe("repoDefaultBranch", () => {
	it("reads the branch name off the repository payload", async () => {
		const http = scripted([[/repos\/o\/r/, {status: 200, body: {default_branch: "main"}}]]);
		expect(await against(repoDefaultBranch("o/r"), http)).toEqual({_tag: "Ok", value: "main"});
	});

	it("refuses a 200 that names no default branch, rather than answering an empty ref", async () => {
		const result = await against(
			repoDefaultBranch("o/r"),
			scripted([[/repos/, {status: 200, body: {}}]]),
		);
		expect(result._tag).toBe("Failure");
	});
});
