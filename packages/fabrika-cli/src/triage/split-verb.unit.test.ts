import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type HttpReply, okOut, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {renderFooter} from "../report/compose.ts";
import {COMMENTS, claimPage, EXPIRED, guardedShell, LIVE} from "./claim-fixtures.test-support.ts";
import {
	CLAIMED_ELSEWHERE,
	EMPTY_STDIN,
	LEAKED_PATH,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {composeChildBody} from "./split.ts";
import {runSplit} from "./split-verb.ts";

const BRANCH = /^git rev-parse/;
const PARENT = /GET .*\/repos\/o\/r\/issues\/4312$/;
const LABELS = /GET .*\/repos\/o\/r\/labels\?/;
const QUEUE = /GET .*\/repos\/o\/r\/issues\?state=open/;
const TIMELINE = /GET .*\/repos\/o\/r\/issues\/4312\/timeline\?/;
const CREATE = /POST .*\/repos\/o\/r\/issues$/;
const CROSSLINK = /POST .*\/repos\/o\/r\/issues\/4312\/comments$/;
const issueRead = (n: number) => new RegExp(`GET .*/repos/o/r/issues/${n}$`);

const UNREADABLE: HttpReply = {status: 502, body: "{}"};
const NOT_FOUND: HttpReply = {status: 404, body: '{"message":"Not Found"}'};
const WRITE_FAILED: HttpReply = {status: 500, body: "{}"};

const labels = (...names: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(names.map((name) => ({name}))),
});

/** Open issues carrying the queue label, as the list endpoint answers them. */
const queue = (
	...rows: ReadonlyArray<{readonly number: number; readonly title: string}>
): HttpReply => ({status: 200, body: JSON.stringify(rows)});

/** `cross-referenced` timeline entries — the only event shape the adapter reads. */
const timeline = (
	...refs: ReadonlyArray<{readonly number: number; readonly pull?: boolean}>
): HttpReply => ({
	status: 200,
	body: JSON.stringify(
		refs.map((ref) => ({
			event: "cross-referenced",
			source: {
				issue: {number: ref.number, ...(ref.pull === true ? {pull_request: {url: "x"}} : {})},
			},
		})),
	),
});

/** What the first request matching `pattern` carried as its JSON body. */
const bodyOf = (
	requests: ReadonlyArray<string>,
	bodies: ReadonlyArray<string>,
	pattern: RegExp,
): string => {
	const at = requests.findIndex((line) => pattern.test(line));
	return at < 0 ? "" : (bodies[at] ?? "");
};

const TITLE = "Editor loses focus after save";
const BODY = "The editor drops focus once the save round-trips.";

const COMPOSED = composeChildBody(
	BODY,
	4312,
	renderFooter({
		session: null,
		model: null,
		branch: "umut/x",
		timestamp: "2026-01-01T00:00:00Z",
	}),
);

const issue = (over: Record<string, unknown>): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4321,
		title: TITLE,
		body: COMPOSED,
		state: "open",
		labels: [{name: "status:needs-triage"}],
		html_url: "https://example.test/issues/4321",
		...over,
	}),
});

const parentIssue = issue({number: 4312, title: "Two unrelated bugs", body: "a\nb"});
const created: HttpReply = {
	status: 201,
	body: JSON.stringify({number: 4321, html_url: "https://example.test/issues/4321"}),
};
const posted: HttpReply = {
	status: 201,
	body: JSON.stringify({id: 7, html_url: "https://example.test/c/7"}),
};

const options = {
	parent: 4312,
	title: TITLE,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: BODY}),
	now: () => new Date("2026-01-01T00:00:00.000Z"),
};

/** The base script: parent present, label present, nothing already split, create + cross-link fine. */
const base: ReadonlyArray<Scripted> = [
	[BRANCH, okOut("umut/x\n")],
	[PARENT, parentIssue],
	[LABELS, labels("status:needs-triage", "type:bug")],
	[QUEUE, queue()],
	[TIMELINE, timeline()],
	[CREATE, created],
	[CROSSLINK, posted],
	[issueRead(4321), issue({})],
];

const script = (...overrides: ReadonlyArray<Scripted>): ReadonlyArray<Scripted> => [
	...overrides,
	...base,
];

const run = (steps: ReadonlyArray<Scripted> = base, over: Partial<typeof options> = {}) => {
	const shell = guardedShell(steps);
	return Effect.runPromise(Effect.provide(runSplit({...options, ...over}), shell.layer)).then(
		(outcome) => ({
			outcome,
			calls: shell.calls,
			requests: shell.requests,
			bodies: shell.bodies,
		}),
	);
};

describe("runSplit — the created path", () => {
	it("prints the outcome token, the number and the url, tab-separated", async () => {
		const {outcome} = await run();
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("created\t4321\thttps://example.test/issues/4321\n");
	});

	it("creates the child carrying the back-reference and the queue label", async () => {
		const {requests, bodies} = await run();
		const create = bodyOf(requests, bodies, CREATE);
		expect(create).toContain("split from #4312");
		expect(create).toContain("Filed by an agent");
		expect(create).toContain('"labels":["status:needs-triage"]');
	});

	it("cross-links the parent as part of the same operation", async () => {
		const {requests, bodies} = await run();
		expect(bodyOf(requests, bodies, CROSSLINK)).toContain("split into #4321");
	});

	it("reports the object with --json", async () => {
		const {outcome} = await run(base, {json: true});
		expect(JSON.parse(outcome.stdout)).toEqual({
			outcome: "created",
			number: 4321,
			url: "https://example.test/issues/4321",
			matchedOn: null,
			crossLinked: true,
		});
	});

	it("reports the scanned count of both list reads", async () => {
		const {outcome} = await run();
		const stderr = outcome.stderr.join("\n");
		expect(stderr).toContain("scanned 0 open status:needs-triage issues in o/r");
		expect(stderr).toContain("scanned 0 timeline cross-references in o/r");
	});

	it("still exits 0 when the cross-link fails — the child demonstrably exists", async () => {
		const {outcome} = await run(script([CROSSLINK, WRITE_FAILED]), {json: true});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).crossLinked).toBe(false);
		expect(outcome.stderr.join("\n")).toContain("add the comment by hand");
	});
});

describe("runSplit — the create-once key", () => {
	const sibling = issue({number: 4400, title: "Autosave drops the draft"});
	const foreign = issue({number: 4400, body: "unrelated\n\nsplit from #9999\n"});

	it("reuses a child matching BOTH halves of the key, and writes nothing", async () => {
		const {outcome, requests} = await run(
			script([QUEUE, queue({number: 4321, title: TITLE})], [issueRead(4321), issue({})]),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("reused\t4321\thttps://example.test/issues/4321\n");
		expect(requests.some((c) => CREATE.test(c))).toBe(false);
		expect(requests.some((c) => CROSSLINK.test(c))).toBe(false);
	});

	it("names the key it matched on, and never claims a cross-link it did not make", async () => {
		const {outcome} = await run(
			script([QUEUE, queue({number: 4321, title: TITLE})], [issueRead(4321), issue({})]),
			{json: true},
		);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			outcome: "reused",
			matchedOn: "back-reference+title",
			crossLinked: false,
		});
	});

	it("does NOT reuse on the title alone — a same-titled child of another parent is not this child", async () => {
		const {outcome} = await run(
			script([QUEUE, queue({number: 4400, title: TITLE})], [issueRead(4400), foreign]),
		);
		expect(outcome.stdout).toBe("created\t4321\thttps://example.test/issues/4321\n");
	});

	// Routed through the TIMELINE deliberately: that read carries no titles, so every cross-reference
	// is fetched and tested, and the AND is the only thing standing between this sibling and a false
	// reuse. Through the queue the title narrowing would reject it before the key ran at all.
	it("does NOT reuse on the back-reference alone — a sibling split is not this child", async () => {
		const {outcome} = await run(
			script([TIMELINE, timeline({number: 4400})], [issueRead(4400), sibling]),
		);
		expect(outcome.stdout).toBe("created\t4321\thttps://example.test/issues/4321\n");
	});

	it("reaches a child already triaged out of the queue, through the timeline", async () => {
		const {outcome} = await run(
			script([TIMELINE, timeline({number: 4321})], [issueRead(4321), issue({})]),
		);
		expect(outcome.stdout).toBe("reused\t4321\thttps://example.test/issues/4321\n");
	});

	it("ignores pull requests in the timeline", async () => {
		const {outcome, requests} = await run(script([TIMELINE, timeline({number: 9001, pull: true})]));
		expect(outcome.stdout).toBe("created\t4321\thttps://example.test/issues/4321\n");
		expect(requests.some((c) => issueRead(9001).test(c))).toBe(false);
	});

	it("narrows on the title before fetching, so an unrelated queue row costs no read", async () => {
		const {requests} = await run(
			script([QUEUE, queue({number: 4400, title: "Something else entirely"})]),
		);
		expect(requests.some((c) => issueRead(4400).test(c))).toBe(false);
	});
});

describe("runSplit — a read that cannot see is never an answer", () => {
	it("exits 11 on an UNKNOWN candidate body, and creates nothing", async () => {
		const {outcome, requests} = await run(
			script([QUEUE, queue({number: 4400, title: TITLE})], [issueRead(4400), UNREADABLE]),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain("refusing to create a possible twin");
		expect(requests.some((c) => CREATE.test(c))).toBe(false);
	});

	// The same refusal on the second loop. The timeline read carries no titles, so it fetches every
	// cross-reference — an UNKNOWN one there is just as likely to BE the child as an UNKNOWN queue row.
	it("exits 11 on an UNKNOWN timeline candidate too, not only a queue one", async () => {
		const {outcome, requests} = await run(
			script([TIMELINE, timeline({number: 4400})], [issueRead(4400), UNREADABLE]),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(requests.some((c) => CREATE.test(c))).toBe(false);
	});

	it("exits 11 on an unreadable queue, never on a silent create", async () => {
		const {outcome, requests} = await run(script([QUEUE, UNREADABLE]));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(requests.some((c) => CREATE.test(c))).toBe(false);
	});

	it("exits 11 on an unreadable timeline", async () => {
		const {outcome, requests} = await run(script([TIMELINE, UNREADABLE]));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(requests.some((c) => CREATE.test(c))).toBe(false);
	});

	it("exits 11 on an unreadable parent, and 7 on one proven absent", async () => {
		const unreadable = await run(script([PARENT, UNREADABLE]));
		expect(unreadable.outcome.code).toBe(PRECONDITION_UNKNOWN);
		const absent = await run(script([PARENT, NOT_FOUND]));
		expect(absent.outcome.code).toBe(ZERO_SCOPE);
		expect(absent.outcome.stderr.at(-1)).toBe("triage split: parent #4312 not found in o/r.");
	});

	it("exits 11 on an unreadable label set", async () => {
		const {outcome} = await run(script([LABELS, UNREADABLE]));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("exits 7 when the queue label does not exist — a 200 over [] is not a proven negative", async () => {
		const {outcome, requests} = await run(script([LABELS, labels("type:bug", "p0")]));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.at(-1)).toContain("(ADR 0092)");
		expect(requests.some((c) => CREATE.test(c))).toBe(false);
	});
});

describe("runSplit — the write and its read-back", () => {
	it("exits 8 with the re-run recovery when the create fails", async () => {
		const {outcome} = await run(script([CREATE, WRITE_FAILED]));
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain("which will reuse it if it did");
	});

	it("exits 9 when the landed child is not what was composed", async () => {
		const {outcome} = await run(script([issueRead(4321), issue({body: "something else"})]));
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stderr.at(-1)).toBe(
			"triage split: child #4321 created but its body read back changed — inspect before splitting further.",
		);
	});

	it("exits 9 when the read-back itself fails", async () => {
		const {outcome} = await run(script([issueRead(4321), UNREADABLE]));
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});

	it("tolerates a trailing-newline difference — the normalised comparison owns that", async () => {
		const {outcome} = await run(
			script([issueRead(4321), issue({body: `${COMPOSED.trimEnd()}\n\n\n`})]),
		);
		expect(outcome.code).toBe(0);
	});
});

describe("runSplit — the authored-text guard", () => {
	it("refuses an empty body before any network read", async () => {
		const {outcome, requests} = await run(base, {
			stdin: Effect.succeed({_tag: "Text", text: ""} satisfies StdinRead),
		});
		expect(outcome.code).toBe(EMPTY_STDIN);
		expect(requests).toEqual([]);
	});

	it("scans the COMPOSED body, so nothing the verb appends can escape the predicate", async () => {
		const {outcome, requests} = await run(base, {
			stdin: Effect.succeed({
				_tag: "Text",
				text: "reproduced from /Users/someone/scratch/case.md",
			} satisfies StdinRead),
		});
		expect(outcome.code).toBe(LEAKED_PATH);
		expect(requests).toEqual([]);
	});

	it("refuses a non-issue-number parent without touching the network", async () => {
		const {outcome, calls, requests} = await run(base, {parent: 0});
		expect(outcome.code).toBe(1);
		expect(calls).toEqual([]);
		expect(requests).toEqual([]);
	});
});

/** #5644: the guard reads the PARENT — the issue this verb mutates by cross-linking it. */
describe("runSplit — the parent guard", () => {
	const MINE = "session-mine";
	const THEIRS = "session-theirs";
	const mine = {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: MINE} as Record<
		string,
		string | undefined
	>;

	// The composed child body carries the session in its footer, so a run under a session id cannot
	// match COMPOSED's read-back. What the guard decides is whether the create was reached at all.
	const guard = async (steps: ReadonlyArray<Scripted>) => {
		const {outcome, requests} = await run(steps, {env: mine});
		return {outcome, created: requests.some((line) => CREATE.test(line))};
	};

	it("refuses a closed parent on 7 and creates nothing", async () => {
		const {outcome, created} = await guard(
			script([PARENT, issue({number: 4312, title: "Two unrelated bugs", state: "closed"})]),
		);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.at(-1)).toContain("parent #4312 is already closed.");
		expect(created).toBe(false);
	});

	it("refuses a live claim held by another session on 17 and creates nothing", async () => {
		const {outcome, created} = await guard(
			script([COMMENTS, claimPage({session: THEIRS, createdAt: LIVE})]),
		);
		expect(outcome.code).toBe(CLAIMED_ELSEWHERE);
		expect(created).toBe(false);
	});

	it("creates when the live claim is this session's own", async () => {
		const {created} = await guard(script([COMMENTS, claimPage({session: MINE, createdAt: LIVE})]));
		expect(created).toBe(true);
	});

	it("creates over a parent nobody has claimed", async () => {
		const {created} = await guard(base);
		expect(created).toBe(true);
	});

	it("creates when the only foreign claim has aged out", async () => {
		const {created} = await guard(
			script([COMMENTS, claimPage({session: THEIRS, createdAt: EXPIRED})]),
		);
		expect(created).toBe(true);
	});
});
