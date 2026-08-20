import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {composeClaimToken, markerBody} from "./claim.ts";
import {runClaim} from "./claim-verb.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN, ZERO_SCOPE} from "./codes.ts";

const MINE = "b2e1-4c07-4a99-9f30-55da1e6b7c02";
const THEIRS = "7f3c-9a20-4b11-8e05-1d77c2a4f9be";

/** This lane's uuid and the nonce it confers; the sibling shares MINE's session and nothing else. */
const MY_UUID = "aaaaaaaa-1111-4222-8333-444444444444";
const MY_NONCE = "aaaaaaaa";
const MY_TOKEN = composeClaimToken(MINE, MY_UUID);
const SIBLING_UUID = "bbbbbbbb-1111-4222-8333-444444444444";
const SIBLING_NONCE = "bbbbbbbb";
const THEIR_NONCE = "cccccccc";

const ISSUE = /GET .*\/repos\/o\/r\/issues\/4312$/;
const LIST = /GET .*\/repos\/o\/r\/issues\/4312\/comments\?/;
const POST = /POST .*\/repos\/o\/r\/issues\/4312\/comments$/;
const DELETE = /DELETE .*\/repos\/o\/r\/issues\/comments\//;

const UNREADABLE: HttpReply = {status: 502, body: "{}"};
const NOT_FOUND: HttpReply = {status: 404, body: '{"message":"Not Found"}'};
const DELETED: HttpReply = {status: 204, body: ""};

/** What the first request matching `pattern` carried as its JSON body. */
const bodyOf = (
	requests: ReadonlyArray<string>,
	bodies: ReadonlyArray<string>,
	pattern: RegExp,
): string => {
	const at = requests.findIndex((line) => pattern.test(line));
	return at < 0 ? "" : (bodies[at] ?? "");
};

/**
 * A pattern that matches at most once, so the two identical comment-list reads of one run can be
 * scripted with different answers.
 *
 * The whole protocol lives in the difference between the list read before the marker is posted and
 * the read after it, so a fake that cannot tell those two calls apart cannot exercise it at all.
 */
const once = (pattern: RegExp): RegExp => {
	const re = new RegExp(pattern.source);
	let fired = false;
	re.test = (input: string) => {
		if (fired || !RegExp.prototype.test.call(re, input)) return false;
		fired = true;
		return true;
	};
	return re;
};

const issue = (state: string): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4312,
		title: "t",
		body: "b",
		state,
		labels: [],
		html_url: "https://example.test/issues/4312",
	}),
});

const comment = (id: number, body: string, createdAt: string) => ({
	id,
	user: {login: "usirin"},
	created_at: createdAt,
	body,
});

const comments = (...entries: ReadonlyArray<Record<string, unknown>>): HttpReply => ({
	status: 200,
	body: JSON.stringify(entries),
});

const posted = (id: number): HttpReply => ({
	status: 201,
	body: JSON.stringify({id, html_url: `https://example.test/issues/4312#issuecomment-${id}`}),
});

const NOW = new Date("2026-08-02T10:00:00Z");
const MY_MARKER = comment(
	5001,
	markerBody({session: MINE, nonce: MY_NONCE}),
	"2026-08-02T09:50:00Z",
);
const SIBLING_MARKER = comment(
	4003,
	markerBody({session: MINE, nonce: SIBLING_NONCE}),
	"2026-08-02T09:14:02Z",
);
const THEIR_MARKER = comment(
	4002,
	markerBody({session: THEIRS, nonce: THEIR_NONCE}),
	"2026-08-02T09:14:02Z",
);

const options = {
	issue: 4312,
	repo: null,
	json: false,
	token: null as string | null,
	uuid: MY_UUID,
	env: {
		CLAUDE_PIPELINE_REPO: "o/r",
		CLAUDE_CODE_SESSION_ID: MINE,
	} as Record<string, string | undefined>,
	now: () => NOW,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const shell = fakeSeams(script);
	return Effect.runPromise(Effect.provide(runClaim({...options, ...overrides}), shell.layer)).then(
		(outcome) => ({outcome, requests: shell.requests, bodies: shell.bodies}),
	);
};

/** before: nobody. post lands. after: only mine. */
const winning = (): ReadonlyArray<Scripted> => [
	[ISSUE, issue("open")],
	[POST, posted(5001)],
	[once(LIST), comments()],
	[LIST, comments(MY_MARKER)],
];

/** before: theirs is already there. post lands. after: both. */
const losing = (): ReadonlyArray<Scripted> => [
	[ISSUE, issue("open")],
	[POST, posted(5001)],
	[once(LIST), comments(THEIR_MARKER)],
	[LIST, comments(THEIR_MARKER, MY_MARKER)],
];

describe("runClaim — winning", () => {
	it("posts the exact marker literal and prints the state word `won`", async () => {
		const {outcome, requests, bodies} = await run(winning());
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(`won\t${MY_TOKEN}\n`);
		expect(bodyOf(requests, bodies, POST)).toContain(
			`"body":${JSON.stringify(markerBody({session: MINE, nonce: MY_NONCE}))}`,
		);
	});

	it("reports the scanned comment count on stderr — a verdict names its scope", async () => {
		const {outcome} = await run(winning());
		expect(outcome.stderr.join("\n")).toContain("triage claim: scanned 1 comment in o/r.");
	});

	it("emits the result object under --json", async () => {
		const {outcome} = await run(winning(), {json: true});
		expect(JSON.parse(outcome.stdout)).toEqual({
			outcome: "won",
			session: MINE,
			token: MY_TOKEN,
			holder: null,
			holderLane: null,
			markers: 1,
			expired: 0,
		});
	});

	it("wins over a marker the TTL has aged out, and counts it as expired", async () => {
		const stale = comment(
			4002,
			markerBody({session: THEIRS, nonce: THEIR_NONCE}),
			"2026-08-02T08:00:00Z",
		);
		const {outcome} = await run(
			[
				[ISSUE, issue("open")],
				[POST, posted(5001)],
				[once(LIST), comments(stale)],
				[LIST, comments(stale, MY_MARKER)],
			],
			{json: true},
		);
		expect(JSON.parse(outcome.stdout)).toMatchObject({outcome: "won", markers: 1, expired: 1});
	});

	it("re-resolves rather than posting a second marker when this LANE already holds one", async () => {
		const {outcome, requests} = await run(
			[
				[ISSUE, issue("open")],
				[LIST, comments(MY_MARKER)],
			],
			{token: MY_TOKEN},
		);
		expect(outcome.stdout).toBe(`won\t${MY_TOKEN}\n`);
		expect(requests.filter((c) => POST.test(c))).toHaveLength(0);
		expect(requests.filter((c) => LIST.test(c))).toHaveLength(1);
	});
});

describe("runClaim — two lanes of one session", () => {
	// The defect: both siblings share CLAUDE_CODE_SESSION_ID, so a session-only marker read each
	// sibling's claim back as its own and both wrote the issue (#6132).
	const race = (): ReadonlyArray<Scripted> => [
		[ISSUE, issue("open")],
		[POST, posted(5001)],
		[once(LIST), comments(SIBLING_MARKER)],
		[LIST, comments(SIBLING_MARKER, MY_MARKER)],
		[DELETE, DELETED],
	];

	it("loses to a sibling lane of its own session instead of adopting its marker", async () => {
		const {outcome} = await run(race());
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(`lost\t${MINE}\n`);
		expect(outcome.stderr.join("\n")).toContain(
			`#4312 is held by session ${MINE} on lane ${SIBLING_NONCE}`,
		);
	});

	it("retracts its OWN marker on that loss, never the sibling's", async () => {
		const {requests} = await run(race());
		const deletes = requests.filter((c) => DELETE.test(c));
		expect(deletes).toHaveLength(1);
		expect(deletes[0]).toContain("issues/comments/5001");
	});

	it("posts its own marker rather than reading the sibling's as a re-entry", async () => {
		const {requests} = await run(race());
		expect(requests.filter((c) => POST.test(c))).toHaveLength(1);
	});

	it("wins when its own marker is the earliest — the sibling is later, not equal", async () => {
		const later = {...SIBLING_MARKER, created_at: "2026-08-02T09:55:00Z"};
		const {outcome} = await run([
			[ISSUE, issue("open")],
			[POST, posted(5001)],
			[once(LIST), comments()],
			[LIST, comments(MY_MARKER, later)],
		]);
		expect(outcome.stdout).toBe(`won\t${MY_TOKEN}\n`);
	});
});

describe("runClaim — --token", () => {
	it("refuses at 1 on a token that is not a triage claim token", async () => {
		const {outcome, requests} = await run([], {token: "build:whoever:0123456789ab"});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.join("\n")).toContain("which lane is asking is not stated");
		expect(requests).toHaveLength(0);
	});

	it("refuses at 1 on another session's token — a lane names itself, never another", async () => {
		const {outcome, requests} = await run([], {token: composeClaimToken(THEIRS, SIBLING_UUID)});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.join("\n")).toContain(`carries session ${THEIRS}`);
		expect(requests).toHaveLength(0);
	});

	it("re-posts under the named lane when its marker aged out, and answers with that same token", async () => {
		const {outcome, requests, bodies} = await run(
			[
				[ISSUE, issue("open")],
				[POST, posted(5001)],
				[once(LIST), comments()],
				[LIST, comments(MY_MARKER)],
			],
			{token: MY_TOKEN},
		);
		expect(outcome.stdout).toBe(`won\t${MY_TOKEN}\n`);
		expect(bodyOf(requests, bodies, POST)).toContain(
			`"body":${JSON.stringify(markerBody({session: MINE, nonce: MY_NONCE}))}`,
		);
	});
});

describe("runClaim — losing", () => {
	it("prints `lost\\t<holder>` at exit 0 and names the holder in full", async () => {
		const {outcome} = await run([...losing(), [DELETE, DELETED]]);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(`lost\t${THEIRS}\n`);
		expect(outcome.stderr.join("\n")).toContain(
			`#4312 is held by session ${THEIRS} on lane ${THEIR_NONCE} since 2026-08-02T09:14:02Z — backing off.`,
		);
	});

	it("deletes its OWN marker and only that one", async () => {
		const {requests} = await run([...losing(), [DELETE, DELETED]]);
		const deletes = requests.filter((c) => DELETE.test(c));
		expect(deletes).toHaveLength(1);
		expect(deletes[0]).toContain("issues/comments/5001");
	});

	it("refuses at 9 when the conceded marker cannot be deleted — a live stale claim is not an aside", async () => {
		const {outcome} = await run([...losing(), [DELETE, {status: 403, body: "{}"}]]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(
			"a stale claim is live on the issue until 2026-08-02T10:50:00.000Z; delete it by hand.",
		);
	});
});

describe("runClaim — `won` requires positive proof", () => {
	it("refuses at 11 when the comment list read fails — never `no competing claim`", async () => {
		const {outcome} = await run([
			[ISSUE, issue("open")],
			[POST, posted(5001)],
			[once(LIST), comments()],
			[LIST, UNREADABLE],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain('no claim was resolved; never "won"');
	});

	it("refuses at 11 when the comment payload is not a list, even though GitHub answered 200", async () => {
		const {outcome} = await run([
			[ISSUE, issue("open")],
			[POST, posted(5001)],
			[once(LIST), comments()],
			[LIST, {status: 200, body: '{"message":"Not Found"}'}],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});

	it("refuses at 11 when an entry is not a comment — a shape mismatch is never an empty field", async () => {
		const {outcome} = await run([
			[ISSUE, issue("open")],
			[POST, posted(5001)],
			[once(LIST), comments()],
			[LIST, {status: 200, body: '[{"note":"no id here"}]'}],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses at 11 when a marker's ordering key will not parse", async () => {
		const undated = {...THEIR_MARKER, created_at: ""};
		const {outcome} = await run([
			[ISSUE, issue("open")],
			[POST, posted(5001)],
			[once(LIST), comments()],
			[LIST, comments(undated, MY_MARKER)],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});

	it("refuses at 9 when the posted marker is absent from the read-back", async () => {
		const {outcome} = await run([
			[ISSUE, issue("open")],
			[POST, posted(5001)],
			[once(LIST), comments()],
			[LIST, comments()],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stderr.join("\n")).toContain("absent on read-back");
	});

	it("loses to a malformed marker rather than ignoring it", async () => {
		const malformed = comment(
			4002,
			"<!-- fabrika-triage-claim session= -->",
			"2026-08-02T09:14:02Z",
		);
		const {outcome} = await run([
			[ISSUE, issue("open")],
			[POST, posted(5001)],
			[once(LIST), comments(malformed)],
			[LIST, comments(malformed, MY_MARKER)],
			[DELETE, DELETED],
		]);
		expect(outcome.stdout).toBe("lost\t\n");
	});
});

describe("runClaim — preconditions", () => {
	it("refuses at 1 with an unset session id, and touches the network for nothing", async () => {
		const {outcome, requests} = await run([], {
			env: {CLAUDE_PIPELINE_REPO: "o/r"},
		});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.join("\n")).toContain(
			"CLAUDE_CODE_SESSION_ID is unset — refusing to post an unattributable claim.",
		);
		expect(requests).toHaveLength(0);
	});

	it("refuses at 1 on a session id that would not read back as itself", async () => {
		const {outcome} = await run([], {
			env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "two tokens"},
		});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.join("\n")).toContain("not a single token");
	});

	it("refuses at 7 on a proven-absent issue", async () => {
		const {outcome} = await run([[ISSUE, NOT_FOUND]]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("issue #4312 not found in o/r.");
	});

	it("refuses at 7 on a closed issue — nothing to triage", async () => {
		const {outcome, requests} = await run([[ISSUE, issue("closed")]]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(requests.filter((c) => POST.test(c))).toHaveLength(0);
	});

	it("refuses at 11 on an unreadable issue — a 502 is not a fact about anything", async () => {
		const {outcome} = await run([[ISSUE, UNREADABLE]]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("posts nothing when the FIRST comment read fails", async () => {
		const {outcome, requests} = await run([
			[ISSUE, issue("open")],
			[LIST, UNREADABLE],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(requests.filter((c) => POST.test(c))).toHaveLength(0);
	});

	it("refuses at 8 when the marker POST itself fails — UNKNOWN whether it landed", async () => {
		const {outcome} = await run([
			[ISSUE, issue("open")],
			[LIST, comments()],
			[POST, {status: 503, body: "{}"}],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("re-run before mutating #4312.");
	});

	it("names its own live marker when the post-write read fails", async () => {
		const {outcome} = await run([
			[ISSUE, issue("open")],
			[POST, posted(5001)],
			[once(LIST), comments()],
			[LIST, UNREADABLE],
		]);
		expect(outcome.stderr.join("\n")).toContain("this lane's marker 5001 is live on #4312");
	});

	it("refuses at 1 on a non-issue number", async () => {
		expect((await run([], {issue: 0})).outcome.code).toBe(1);
	});
});
