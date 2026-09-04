/** The board read `lane open` boots on, over the two real seams — epic, child, single, unknown. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GATEWAY, issuePayload, NOT_FOUND, served} from "../build/fixtures.test-support.ts";
import {fakeHttp, fakeShell, type HttpReply, okOut} from "../fakes.test-support.ts";
import {expectationReader} from "./expectation.ts";

const ISSUE_NUMBER = 900;
const ISSUE = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/900$/;
const SUBS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/900\/sub_issues\?/;

const ENV = {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"} as Record<
	string,
	string | undefined
>;

const board = (overrides: Record<string, unknown> = {}): HttpReply =>
	served(issuePayload({number: ISSUE_NUMBER, labels: [{name: "status:triaged"}], ...overrides}));

const epicLabelled = (overrides: Record<string, unknown> = {}): HttpReply =>
	board({labels: [{name: "type:epic"}, {name: "status:triaged"}], ...overrides});

const subIssues = (...numbers: ReadonlyArray<number>): HttpReply => ({
	status: 200,
	body: JSON.stringify(numbers.map((number) => ({number, state: "open", state_reason: null}))),
});

const NO_CHILDREN = subIssues();

/** No `gh`/`git` answers anything: an explicit repo must never reach a subprocess for one. */
const readAt = (
	script: ReadonlyArray<readonly [RegExp, HttpReply]>,
	issue = ISSUE_NUMBER,
	repo: string | null = "o/r",
	env = ENV,
) =>
	Effect.runPromise(
		Effect.provide(
			expectationReader(repo, env)(issue),
			Layer.merge(fakeShell([]).layer, fakeHttp(script).layer),
		),
	);

describe("expectationReader reads an epic ahead of a child, however the issue also hangs", () => {
	it("reads a labelled epic that carries a parent edge as Epic, not as its parent's child", async () => {
		const read = await readAt([
			[ISSUE, epicLabelled({parent: {number: 4304}})],
			[SUBS, NO_CHILDREN],
		]);

		expect(read).toEqual({_tag: "Read", expectation: {_tag: "Epic", children: 0}});
	});

	it("reads an unlabelled issue carrying sub-issue links as an Epic of that many children", async () => {
		const read = await readAt([
			[ISSUE, board()],
			[SUBS, subIssues(901, 902, 903)],
		]);

		expect(read).toEqual({_tag: "Read", expectation: {_tag: "Epic", children: 3}});
	});

	it("reads a pre-plan epic — labelled, no children yet — as an Epic rather than an ordinary issue", async () => {
		const read = await readAt([
			[ISSUE, epicLabelled()],
			[SUBS, NO_CHILDREN],
		]);

		expect(read).toEqual({_tag: "Read", expectation: {_tag: "Epic", children: 0}});
	});
});

describe("expectationReader names the parent an issue hangs under when nothing says epic", () => {
	it("reads a named parent off the `parent` record", async () => {
		const read = await readAt([
			[ISSUE, board({parent: {number: 4304}})],
			[SUBS, NO_CHILDREN],
		]);

		expect(read).toEqual({_tag: "Read", expectation: {_tag: "Child", parent: 4304}});
	});

	it("reads a named parent off `parent_issue_url` alone", async () => {
		const read = await readAt([
			[ISSUE, board({parent_issue_url: "https://api.github.com/repos/o/r/issues/4304"})],
			[SUBS, NO_CHILDREN],
		]);

		expect(read).toEqual({_tag: "Read", expectation: {_tag: "Child", parent: 4304}});
	});

	it("reads an edge whose number does not parse as a Child with no parent to name", async () => {
		const read = await readAt([
			[ISSUE, board({parent: {url: "https://github.com/o/r/issues/whatever"}})],
			[SUBS, NO_CHILDREN],
		]);

		expect(read).toEqual({_tag: "Read", expectation: {_tag: "Child", parent: null}});
	});

	it("reads an issue with no epic signal and no parent edge as Single", async () => {
		const read = await readAt([
			[ISSUE, board()],
			[SUBS, NO_CHILDREN],
		]);

		expect(read).toEqual({_tag: "Read", expectation: {_tag: "Single"}});
	});
});

describe("an unreadable answer is Unknown, never Single", () => {
	it("seats an unreadable issue read on Unknown, carrying the read's own reason", async () => {
		const read = await readAt([[ISSUE, GATEWAY]]);

		expect(read._tag).toBe("Unknown");
		expect(read).toMatchObject({reason: expect.stringContaining("cannot read #900")});
	});

	it("seats a proven-absent issue on Unknown, naming the repo it is absent from", async () => {
		const read = await readAt([[ISSUE, NOT_FOUND]]);

		expect(read).toEqual({_tag: "Unknown", reason: "#900 is not present on o/r"});
	});

	it("seats an unreadable child list on Unknown — never on an epic with no children", async () => {
		const read = await readAt([
			[ISSUE, board()],
			[SUBS, {status: 503, body: '{"message":"unreachable"}'}],
		]);

		expect(read._tag).toBe("Unknown");
		expect(read).toMatchObject({reason: expect.stringContaining("cannot read #900's children")});
	});

	it("seats an unresolvable repo on Unknown before any board read is issued", async () => {
		const http = fakeHttp([]);
		const read = await Effect.runPromise(
			Effect.provide(
				expectationReader(null, {})(ISSUE_NUMBER),
				Layer.merge(fakeShell([]).layer, http.layer),
			),
		);

		expect(read).toEqual({
			_tag: "Unknown",
			reason: "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name",
		});
		expect(http.calls).toEqual([]);
	});
});

describe("one reader resolves its repo once", () => {
	it("asks git for the origin repo on the first read and never again", async () => {
		const shell = fakeShell([[/^git remote get-url origin$/, okOut("git@github.com:o/r.git\n")]]);
		const http = fakeHttp([
			[ISSUE, board()],
			[SUBS, NO_CHILDREN],
		]);
		const read = expectationReader(null, {GITHUB_TOKEN: "ghp_scripted"});
		const layer = Layer.merge(shell.layer, http.layer);

		const first = await Effect.runPromise(Effect.provide(read(ISSUE_NUMBER), layer));
		const second = await Effect.runPromise(Effect.provide(read(ISSUE_NUMBER), layer));

		expect(first).toEqual({_tag: "Read", expectation: {_tag: "Single"}});
		expect(second).toEqual(first);
		expect(shell.calls).toEqual(["git remote get-url origin"]);
	});
});
