import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	KIND_MISMATCH,
	LANE_NOT_MINE,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	TICKET_RETIRED,
	TICKET_UNKNOWN,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	commentsJson,
	issueJson,
	MAP,
	MAP_BODY,
	NONCE,
	REPO,
	TICKET,
} from "./fixtures.test-support.ts";
import {runLane} from "./lane-verb.ts";
import {composeLaneMarker, composeRetiredMarker, composeTicketMarker} from "./markers.ts";

const POST = /--method POST repos\/o\/r\/issues\/9142\/comments/;
const GET_COMMENT = /issues\/comments\/\d+/;
const PERMISSION = /collaborators\/.*\/permission/;
const CHILDREN = /issues\/9140\/sub_issues/;
const TICKET_COMMENTS = /issues\/9142\/comments/;
const EDGES = /issues\/9142\/dependencies\//;
const TICKET_ISSUE = /issues\/9142$/;
const MAP_ISSUE = /issues\/9140$/;

const ticketMarker = (kind: "research" | "decision" | "prototype" = "research") =>
	composeTicketMarker({map: MAP, kind, nonce: NONCE});

const options = {
	map: MAP,
	ticket: TICKET,
	nonce: NONCE,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: REPO},
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	over: Partial<typeof options> = {},
) => Effect.runPromise(Effect.provide(runLane({...options, ...over}), fakeShell(script).layer));

const frontier = (
	comments: ReadonlyArray<{readonly id: number; readonly body: string}>,
	ticketState = "open",
) =>
	[
		[PERMISSION, okOut("write")],
		[CHILDREN, okOut(`[{"number":${TICKET}}]`)],
		[TICKET_COMMENTS, okOut(commentsJson(comments))],
		[EDGES, okOut("[]")],
		[TICKET_ISSUE, okOut(issueJson({number: TICKET, body: "which table?", state: ticketState}))],
		[MAP_ISSUE, okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]}))],
	] as const;

describe("runLane", () => {
	it("exits 1 on a lane key two runs would collide on, before any read", async () => {
		const out = await run([], {nonce: "run-1"});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("is not a lane key");
	});

	it("exits 0 and holds the lane when it is free", async () => {
		const body = composeLaneMarker({map: MAP, ticket: TICKET, nonce: NONCE});
		const out = await run([
			[POST, okOut('{"id":7,"html_url":"u"}')],
			[GET_COMMENT, okOut(JSON.stringify({body}))],
			...frontier([{id: 1, body: ticketMarker()}]),
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			map: MAP,
			ticket: TICKET,
			nonce: NONCE,
			lane: "held",
		});
	});

	it("exits 0 with `resumed` when this nonce already holds it — a re-run is not an error", async () => {
		const out = await run([
			...frontier([
				{id: 1, body: ticketMarker()},
				{id: 2, body: composeLaneMarker({map: MAP, ticket: TICKET, nonce: NONCE})},
			]),
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).lane).toBe("resumed");
	});

	it("exits 15 when another nonce holds the lane", async () => {
		const out = await run([
			...frontier([
				{id: 1, body: ticketMarker()},
				{id: 2, body: composeLaneMarker({map: MAP, ticket: TICKET, nonce: "bbbbbbbb"})},
			]),
		]);
		expect(out.code).toBe(LANE_NOT_MINE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("bbbbbbbb");
	});

	it("exits 20 on a decision ticket — it is routed, never researched", async () => {
		const out = await run([...frontier([{id: 1, body: ticketMarker("decision")}])]);
		expect(out.code).toBe(KIND_MISMATCH);
		expect(out.stderr.join("\n")).toContain("Route it with map fork");
	});

	it("exits 18 on a ticket that already left the frontier", async () => {
		const out = await run([
			...frontier(
				[
					{id: 1, body: ticketMarker()},
					{
						id: 2,
						body: composeRetiredMarker({map: MAP, ticket: TICKET, direction: "a decay curve"}),
					},
				],
				"closed",
			),
		]);
		expect(out.code).toBe(TICKET_RETIRED);
		expect(out.stdout).toBe("");
	});

	it("exits 13 when the number is not a frontier ticket of this map", async () => {
		const out = await run([...frontier([{id: 1, body: ticketMarker()}])], {ticket: 9999});
		expect(out.code).toBe(TICKET_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 11 when the comment read fails — whether a lane is held is UNKNOWN, never free", async () => {
		const out = await run([
			[TICKET_COMMENTS, errOut("gh: Bad gateway (HTTP 502)")],
			...frontier([{id: 1, body: ticketMarker()}]).slice(3),
			[PERMISSION, okOut("write")],
			[CHILDREN, okOut(`[{"number":${TICKET}}]`)],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 8 when the claim write fails — whether the lane is held is UNKNOWN", async () => {
		const out = await run([
			[POST, errOut("gh: Bad gateway (HTTP 502)")],
			...frontier([{id: 1, body: ticketMarker()}]),
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 9 when the posted marker does not read back — the stamp is verified, never assumed", async () => {
		const out = await run([
			[POST, okOut('{"id":7,"html_url":"u"}')],
			[GET_COMMENT, okOut(JSON.stringify({body: "something else entirely"}))],
			...frontier([{id: 1, body: ticketMarker()}]),
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stdout).toBe("");
	});
});
