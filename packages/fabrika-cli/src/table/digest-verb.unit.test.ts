/**
 * `table digest` against an in-memory issue list, on-call board and recorded webhook: what it
 * sends, when it stays silent, and that neither a failed read nor a failed post passes for an empty
 * report.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeShell, unconfigured} from "../fakes.test-support.ts";
import {type Attempt, fail, ok} from "../io/git.ts";
import type {ListedIssue} from "../io/issues.ts";
import type {ProjectItem, ProjectSnapshot, ProjectsAnswer} from "../io/projects.ts";
import {
	CONFIG_MALFORMED,
	NO_WEBHOOK,
	PRECONDITION_UNKNOWN,
	SCOPE_MISSING,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {type DigestBoard, runDigest} from "./digest-verb.ts";
import type {Located} from "./sync-verb.ts";

const REPO = "acme/widgets";
const NOW = new Date("2026-10-03T12:00:00.000Z");
const URL_TEXT = "https://hooks.example.test/services/T000/B000/secret-token";
const ENV = {FABRIKA_DIGEST_WEBHOOK: URL_TEXT};

const ON_CALL: ProjectSnapshot = {
	id: "PVT_2",
	number: 4,
	owner: {kind: "Organization", login: "acme"},
	url: "https://github.com/orgs/acme/projects/4",
	title: "widgets on-call",
	createdAt: "2026-10-02T12:00:00.000Z",
	shortDescription: null,
	readme: null,
	fields: [],
	views: [],
};

const issue = (number: number, createdAt: string, labels: ReadonlyArray<string>): ListedIssue => ({
	number,
	title: `Issue ${number}`,
	body: "",
	labels,
	author: "octo-owner",
	association: "MEMBER",
	createdAt,
});

const OPEN = [
	issue(1, "2026-10-01T00:00:00.000Z", ["status:needs-triage"]),
	issue(2, "2026-10-03T11:00:00.000Z", []),
	issue(3, "2026-10-03T02:00:00.000Z", ["type:bug", "p0"]),
	issue(4, "2026-09-01T00:00:00.000Z", ["type:bug"]),
	issue(5, "2026-09-01T00:00:00.000Z", ["type:bug", "p0"]),
];

const world = (
	over: {
		issues?: Attempt<ReadonlyArray<ListedIssue>>;
		posted?: Attempt<null>;
		located?: ProjectsAnswer<Located>;
		/** The issues on the on-call board. */
		onCall?: ReadonlyArray<number>;
	} = {},
) => {
	const calls: string[] = [];
	const posts: Array<{tool: string; url: string; text: string}> = [];
	const board: DigestBoard<never> = {
		openIssues: () => {
			calls.push("openIssues");
			return Effect.succeed(over.issues ?? ok(OPEN));
		},
		locate: () => {
			calls.push("locate");
			return Effect.succeed(
				over.located ?? {_tag: "Ok", value: {_tag: "Located", project: ON_CALL}},
			);
		},
		items: () => {
			calls.push("items");
			return Effect.succeed({
				_tag: "Ok" as const,
				value: (over.onCall ?? [3, 4]).map(
					(number): ProjectItem => ({
						itemId: `PVTI_${number}`,
						contentNumber: number,
						contentType: "Issue",
						repository: REPO,
						values: [],
					}),
				),
			});
		},
		post: (tool, url, text) => {
			calls.push("post");
			posts.push({tool, url: url.href, text});
			return Effect.succeed(over.posted ?? ok(null));
		},
	};
	return {board, calls, posts};
};

const config = (blocks: Readonly<Record<string, unknown>>) =>
	fakeFs({files: {"/repo/.fabrika.jsonc": JSON.stringify(blocks)}}).layer;

const SPLIT = {
	onCall: {
		responseTargets: {
			byLabel: [{name: "4h", hours: 4, labels: ["p0"]}],
			otherwise: {name: "3 days", hours: 72},
		},
	},
};

const SLACK = config({digest: {tool: "slack"}, boards: SPLIT});

const digest = (
	board: DigestBoard<never>,
	layer: typeof unconfigured = SLACK,
	over: {env?: Readonly<Record<string, string | undefined>>; dryRun?: boolean} = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runDigest({
				repo: REPO,
				cwd: "/repo",
				env: over.env ?? ENV,
				now: NOW,
				board,
				dryRun: over.dryRun ?? false,
			}),
			Layer.mergeAll(layer, fakeShell([]).layer),
		),
	);

describe("a repository with no digest block", () => {
	it("exits clean, reads nothing and sends nothing", async () => {
		const {board, calls} = world();
		const out = await digest(board, unconfigured, {env: {}});

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({answer: "off"});
		expect(calls).toEqual([]);
	});
});

describe("a repository that opted in", () => {
	it("posts the late triage queue and the late items on the on-call board", async () => {
		const {board, posts} = world();
		const out = await digest(board);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "sent",
			repo: REPO,
			tool: "slack",
			late: 2,
			sections: [
				{section: "triage", late: [{issue: 1, target: "24 hours", waitedHours: 60}]},
				{
					section: "on-call",
					late: [{issue: 3, target: "4h", since: "2026-10-03T02:00:00.000Z", waitedHours: 10}],
				},
			],
			notAsked: [],
		});
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({tool: "slack", url: URL_TEXT});
		expect(posts[0]?.text).toContain("#1 Issue 1: target 24 hours, waited 2 days.");
		expect(posts[0]?.text).toContain("#3 Issue 3: target 4h, waited 10 hours.");
	});

	it("reports the triage queue alone, with no board read, when the block names only that section", async () => {
		const {board, calls} = world();
		const out = await digest(board, config({digest: {tool: "slack", sections: ["triage"]}}));

		expect(JSON.parse(out.stdout)).toMatchObject({answer: "sent", late: 1});
		expect(calls).toEqual(["openIssues", "post"]);
	});

	it("sends nothing when nothing is late", async () => {
		const {board, calls} = world({issues: ok([OPEN[1] as ListedIssue]), onCall: []});
		const out = await digest(board);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "quiet", late: 0, text: null});
		expect(calls).not.toContain("post");
	});

	it("sends the all-clear when the block asks for one", async () => {
		const {board, posts} = world({issues: ok([])});
		const out = await digest(board, config({digest: {tool: "discord", allClear: true}}));

		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "sent",
			tool: "discord",
			late: 0,
			notAsked: ["on-call"],
		});
		expect(posts.map((post) => post.text)).toEqual([
			"acme/widgets: nothing is past its response target.",
		]);
	});

	it("prints the report and sends nothing on --dry-run, with no webhook variable set", async () => {
		const {board, calls} = world();
		const out = await digest(board, SLACK, {env: {}, dryRun: true});

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "dry-run", late: 2});
		expect(JSON.parse(out.stdout).text).toContain("acme/widgets: 2 issues past");
		expect(calls).not.toContain("post");
	});
});

describe("what it refuses", () => {
	it("refuses an unreadable issue list and never reports it as empty", async () => {
		const {board, calls} = world({issues: fail("HTTP 502")});
		const out = await digest(board);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("cannot read acme/widgets's open issues: HTTP 502");
		expect(calls).toEqual(["openIssues"]);
	});

	it("refuses an on-call board it could not read, naming the read and the way out", async () => {
		const unreachable = world({located: {_tag: "Failed", reason: "HTTP 502"}});
		const failed = await digest(unreachable.board);

		expect(failed.code).toBe(PRECONDITION_UNKNOWN);
		expect(failed.stdout).toBe("");
		expect(failed.stderr.join("\n")).toContain("cannot find the on-call board: HTTP 502");
		expect(failed.stderr.join("\n")).toContain("leave `on-call` out of `digest.sections`");
		expect(unreachable.calls).not.toContain("post");

		const unscoped = world({located: {_tag: "MissingScope", reason: "the token lacks the scope"}});
		expect((await digest(unscoped.board)).code).toBe(SCOPE_MISSING);
		expect(unscoped.calls).not.toContain("post");
	});

	it("refuses a failed post, with the webhook URL in no line it prints", async () => {
		const {board} = world({posted: fail(`POST ${URL_TEXT} returned HTTP 404`)});
		const out = await digest(board);
		const printed = [out.stdout, ...out.stderr].join("\n");

		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(printed).toContain("the post to the slack webhook did not land");
		expect(printed).toContain("HTTP 404");
		expect(printed).not.toContain("hooks.example.test");
		expect(printed).not.toContain("secret-token");
	});

	it("refuses before any read when the named variable holds no URL, without printing its value", async () => {
		const unset = world();
		const none = await digest(unset.board, SLACK, {env: {}});

		expect(none.code).toBe(NO_WEBHOOK);
		expect(none.stderr.join("\n")).toContain("FABRIKA_DIGEST_WEBHOOK");
		expect(unset.calls).toEqual([]);

		const junk = world();
		const bad = await digest(junk.board, SLACK, {
			env: {FABRIKA_DIGEST_WEBHOOK: "secret-token-not-a-url"},
		});

		expect(bad.code).toBe(NO_WEBHOOK);
		expect(bad.stderr.join("\n")).not.toContain("secret-token");
		expect(junk.calls).toEqual([]);
	});

	it("refuses a digest block that does not decode", async () => {
		const {board, calls} = world();
		const out = await digest(board, config({digest: {tool: "teams"}}));

		expect(out.code).toBe(CONFIG_MALFORMED);
		expect(out.stderr.join("\n")).toContain("`digest.tool` is not a chat tool");
		expect(calls).toEqual([]);
	});
});
