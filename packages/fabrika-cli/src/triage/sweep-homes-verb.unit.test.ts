/**
 * `triage sweep-homes` over a scripted GitHub: the dry run writes nothing, the apply writes the trail
 * before the clear and reads the clear back, an un-homed issue is never written to, and every read
 * that fails lands as UNKNOWN.
 */
import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	EMPTY_STDIN,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	UNHOMED_REMAIN,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {trailMarker} from "./sweep-homes.ts";
import {runSweepHomes, type SweepMode} from "./sweep-homes-verb.ts";

const BACKLOG = /^GET .*\/repos\/o\/r\/issues\?state=open&labels=status%3Atriaged/;
const ISSUE = /^GET .*\/repos\/o\/r\/issues\/3$/;
const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/3\/comments/;
const POST = /^POST .*\/repos\/o\/r\/issues\/3\/comments$/;
const PATCH = /^PATCH .*\/repos\/o\/r\/issues\/3$/;
const WRITE = /^(POST|PATCH|DELETE) /;

const ENV = {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>;
const LANE = "axis:pipeline-hardening";

interface Shape {
	readonly number: number;
	readonly milestone?: number | null;
	readonly lanes?: ReadonlyArray<string>;
	/** The `comments` count the issue payload declares for itself. */
	readonly comments?: number;
}

const body = (shape: Shape) => ({
	number: shape.number,
	title: `issue ${shape.number}`,
	body: "",
	state: "open",
	labels: ["status:triaged", ...(shape.lanes ?? [])].map((name) => ({name})),
	html_url: `https://example.test/issues/${shape.number}`,
	milestone: shape.milestone == null ? null : {number: shape.milestone},
	...(shape.comments === undefined ? {} : {comments: shape.comments}),
});

const board = (...shapes: ReadonlyArray<Shape>): HttpReply => ({
	status: 200,
	body: JSON.stringify(shapes.map(body)),
});
const one = (shape: Shape): HttpReply => ({status: 200, body: JSON.stringify(body(shape))});
const comments = (...bodies: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(
		bodies.map((text, id) => ({id: id + 1, user: {login: "a"}, body: text, created_at: ""})),
	),
});
const POSTED: HttpReply = {status: 201, body: '{"id":9,"html_url":"https://example.test/c/9"}'};
const ACCEPTED: HttpReply = {status: 200, body: "{}"};
const BROKEN: HttpReply = {status: 500, body: '{"message":"boom"}'};

const DOUBLE: Shape = {number: 3, milestone: 17, lanes: [LANE]};
const SWEPT: Shape = {number: 3, milestone: null, lanes: [LANE]};

const text = (value: string): StdinRead => ({_tag: "Text", text: value});

const run = (
	script: ReadonlyArray<Scripted>,
	mode: SweepMode,
	stdin: StdinRead = text("Per the homing decision."),
) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(
		Effect.provide(
			runSweepHomes({mode, repo: null, json: false, env: ENV, stdin: Effect.succeed(stdin)}),
			seams.layer,
		),
	).then((outcome) => ({outcome, requests: seams.requests, bodies: seams.bodies}));
};

const writes = (requests: ReadonlyArray<string>) => requests.filter((line) => WRITE.test(line));

describe("runSweepHomes — the dry run", () => {
	it("prints the per-issue plan and writes nothing", async () => {
		const {outcome, requests} = await run(
			[[BACKLOG, board({number: 1, milestone: 5}, DOUBLE)]],
			"dry-run",
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(`planned\t1\nwould-clear\t3\t17\t${LANE}\n`);
		expect(writes(requests)).toEqual([]);
	});

	it("reads no stdin, so a dry run needs no citation", async () => {
		const {outcome} = await run([[BACKLOG, board(DOUBLE)]], "dry-run", text(""));
		expect(outcome.code).toBe(0);
	});
});

describe("runSweepHomes — the apply", () => {
	it("posts the trail, then clears the milestone, then reads the clear back", async () => {
		const {outcome, requests, bodies} = await run(
			[
				[BACKLOG, board(DOUBLE)],
				[once(ISSUE), one(DOUBLE)],
				[COMMENTS, comments("unrelated")],
				[POST, POSTED],
				[PATCH, ACCEPTED],
				[ISSUE, one(SWEPT)],
			],
			"apply",
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(`swept\t1\t0\ncleared\t3\t17\t${LANE}\thttps://example.test/c/9\n`);
		const written = writes(requests);
		expect(written.map((line) => line.split(" ")[0])).toEqual(["POST", "PATCH"]);
		const posted = bodies[requests.findIndex((line) => POST.test(line))] ?? "";
		expect(posted).toContain("Per the homing decision.");
		expect(posted).toContain(trailMarker(17).replace(/"/g, '\\"'));
		const patched = bodies[requests.findIndex((line) => PATCH.test(line))] ?? "";
		expect(JSON.parse(patched)).toEqual({milestone: null});
	});

	it("finds an earlier trail and posts no second one", async () => {
		const {outcome, requests} = await run(
			[
				[BACKLOG, board(DOUBLE)],
				[once(ISSUE), one(DOUBLE)],
				[COMMENTS, comments(`earlier\n\n${trailMarker(17)}`)],
				[PATCH, ACCEPTED],
				[ISSUE, one(SWEPT)],
			],
			"apply",
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("cleared\t3\t17\t");
		expect(outcome.stdout).toContain("trail-existing");
		expect(writes(requests).map((line) => line.split(" ")[0])).toEqual(["PATCH"]);
	});

	it("reports zero breaches and writes nothing when re-run over a swept board", async () => {
		const {outcome, requests} = await run([[BACKLOG, board(SWEPT)]], "apply");
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("swept\t0\t0\n");
		expect(outcome.stderr.join("\n")).toContain("0 double-marked");
		expect(writes(requests)).toEqual([]);
	});

	it("skips an issue whose breach moved after the board read", async () => {
		const {outcome, requests} = await run(
			[
				[BACKLOG, board(DOUBLE)],
				[ISSUE, one({number: 3, milestone: 18, lanes: [LANE]})],
			],
			"apply",
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("swept\t0\t1");
		expect(outcome.stdout).toContain("moved\t3\t17\t");
		expect(writes(requests)).toEqual([]);
	});

	it("refuses on 3 with no citation on stdin, before any read", async () => {
		const {outcome, requests} = await run([[BACKLOG, board(DOUBLE)]], "apply", text(""));
		expect(outcome.code).toBe(EMPTY_STDIN);
		expect(requests.filter((line) => BACKLOG.test(line))).toEqual([]);
	});

	it("halts UNKNOWN when the trail write fails, with the milestone untouched", async () => {
		const {outcome, requests} = await run(
			[
				[BACKLOG, board(DOUBLE)],
				[ISSUE, one(DOUBLE)],
				[COMMENTS, comments()],
				[POST, BROKEN],
			],
			"apply",
		);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(requests.some((line) => PATCH.test(line))).toBe(false);
	});

	it("refuses on 9 when the read-back still carries the milestone", async () => {
		const {outcome} = await run(
			[
				[BACKLOG, board(DOUBLE)],
				[ISSUE, one(DOUBLE)],
				[COMMENTS, comments()],
				[POST, POSTED],
				[PATCH, ACCEPTED],
			],
			"apply",
		);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});
});

describe("runSweepHomes — a comment list short of the declared count", () => {
	const saved = process.env.FABRIKA_COMMENT_SCAN_DELAY_MS;
	const DECLARING_ONE: Shape = {...DOUBLE, comments: 1};

	beforeEach(() => {
		process.env.FABRIKA_COMMENT_SCAN_DELAY_MS = "0";
	});

	afterEach(() => {
		if (saved === undefined) delete process.env.FABRIKA_COMMENT_SCAN_DELAY_MS;
		else process.env.FABRIKA_COMMENT_SCAN_DELAY_MS = saved;
	});

	it("re-reads past a list that missed the trail it just posted, and posts no second one", async () => {
		const {outcome, requests} = await run(
			[
				[BACKLOG, board(DOUBLE)],
				[once(ISSUE), one(DOUBLE)],
				// the stale page a re-run right after a halt can read: the trail is not on it yet
				[once(COMMENTS), comments()],
				[once(ISSUE), one(DECLARING_ONE)],
				[once(COMMENTS), comments(`earlier\n\n${trailMarker(17)}`)],
				[once(ISSUE), one(DECLARING_ONE)],
				[PATCH, ACCEPTED],
				[ISSUE, one(SWEPT)],
			],
			"apply",
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("trail-existing");
		expect(writes(requests).map((line) => line.split(" ")[0])).toEqual(["PATCH"]);
	});

	it("halts UNKNOWN and writes nothing when the shortfall survives every re-read", async () => {
		const {outcome, requests} = await run(
			[
				[BACKLOG, board(DOUBLE)],
				[once(ISSUE), one(DOUBLE)],
				[COMMENTS, comments()],
				[ISSUE, one(DECLARING_ONE)],
			],
			"apply",
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("received 0 of 1 declared comment(s)");
		expect(writes(requests)).toEqual([]);
	});
});

describe("runSweepHomes — what it refuses", () => {
	it("clears the double-marked, leaves the un-homed untouched, and exits 27 naming the remedy", async () => {
		const {outcome, requests} = await run(
			[
				[BACKLOG, board(DOUBLE, {number: 4})],
				[once(ISSUE), one(DOUBLE)],
				[COMMENTS, comments()],
				[POST, POSTED],
				[PATCH, ACCEPTED],
				[ISSUE, one(SWEPT)],
			],
			"apply",
		);
		expect(outcome.code).toBe(UNHOMED_REMAIN);
		expect(outcome.stdout).toBe("");
		const stderr = outcome.stderr.join("\n");
		expect(stderr).toContain("unhomed\t4\tissue 4");
		expect(stderr).toContain("home it in an EXISTING open arc/campaign milestone");
		expect(stderr).toContain("kill it");
		expect(requests.some((line) => /\/issues\/4/.test(line))).toBe(false);
	});

	it("exits 27 on a dry run over an un-homed issue too", async () => {
		const {outcome, requests} = await run([[BACKLOG, board({number: 4})]], "dry-run");
		expect(outcome.code).toBe(UNHOMED_REMAIN);
		expect(writes(requests)).toEqual([]);
	});

	it("fails closed on an empty backlog", async () => {
		const {outcome} = await run([[BACKLOG, board()]], "dry-run");
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stdout).toBe("");
	});

	it("reads an unreadable backlog as UNKNOWN, never clean", async () => {
		const {outcome} = await run([[BACKLOG, BROKEN]], "dry-run");
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});
});
