import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {BAD_SECTIONS, NO_TARGET, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	commentsJson,
	digestFor,
	issueJson,
	MAP,
	MAP_BODY,
	NONCE,
	REPO,
	TICKET,
} from "./fixtures.test-support.ts";
import {composeTicketMarker} from "./markers.ts";
import {runRead} from "./read-verb.ts";

const PERMISSION = /collaborators\/.*\/permission/;
const CHILDREN = /issues\/9140\/sub_issues/;
const TICKET_COMMENTS = /issues\/9142\/comments/;
const BLOCKED_BY = /issues\/9142\/dependencies\/blocked_by/;
const BLOCKING = /issues\/9142\/dependencies\/blocking/;
const TICKET_ISSUE = /issues\/9142$/;
const MAP_ISSUE = /issues\/9140$/;

const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
	Effect.runPromise(
		Effect.provide(
			runRead({map: MAP, repo: null, env: {CLAUDE_PIPELINE_REPO: REPO}}),
			fakeShell(script).layer,
		),
	);

const mapOk = [
	MAP_ISSUE,
	okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
] as const;
const marker = composeTicketMarker({map: MAP, kind: "research", nonce: NONCE});
const healthy = [
	[PERMISSION, okOut("write")],
	[CHILDREN, okOut(`[{"number":${TICKET}}]`)],
	[TICKET_COMMENTS, okOut(commentsJson([{id: 1, body: marker}]))],
	[BLOCKED_BY, okOut("[]")],
	[BLOCKING, okOut("[]")],
	[TICKET_ISSUE, okOut(issueJson({number: TICKET, body: "which table carries it?"}))],
	mapOk,
] as const;

describe("runRead", () => {
	it("exits 0 with the frontier token, the digest and one ticket row", async () => {
		const out = await run([...healthy]);
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.frontier).toBe("lanes-pending");
		expect(answer.digest).toBe(digestFor(MAP_BODY));
		expect(answer.tickets).toEqual([
			{
				number: TICKET,
				kind: "research",
				question: "which table carries it?",
				state: "open",
				blockedBy: [],
				blocking: [],
			},
		]);
		expect(answer.counts.open).toBe(1);
		expect(answer.scanned).toEqual({children: 1, edgeReads: 2, comments: 1});
	});

	it("exits 0 with `empty` on a proven-empty child set — zero children is a FACT", async () => {
		const out = await run([[CHILDREN, okOut("[]")], mapOk]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).frontier).toBe("empty");
	});

	it("exits 11 with nothing on stdout when the child read fails — never an empty frontier", async () => {
		const out = await run([[CHILDREN, errOut("gh: Bad gateway (HTTP 502)")], mapOk]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("the frontier is UNKNOWN, never empty");
	});

	it("exits 11 when a permission read fails — never a demotion that frees another run's lane", async () => {
		const out = await run([
			[PERMISSION, errOut("gh: Bad gateway (HTTP 502)")],
			...healthy.slice(1),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 7 on an issue that is not a map, and on one that does not exist", async () => {
		const unlabelled = await run([[MAP_ISSUE, okOut(issueJson({number: MAP, body: MAP_BODY}))]]);
		expect(unlabelled.code).toBe(NO_TARGET);
		expect(unlabelled.stdout).toBe("");
		const missing = await run([[MAP_ISSUE, errOut("gh: Not Found (HTTP 404)")]]);
		expect(missing.code).toBe(NO_TARGET);
		expect(missing.stderr.join("\n")).toContain("is not a wayfinding map");
	});

	it("exits 4 on a body that does not hold the five sections in order", async () => {
		const out = await run([
			[
				MAP_ISSUE,
				okOut(issueJson({number: MAP, body: "## Frontier\n", labels: ["wayfinding:map"]})),
			],
		]);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
	});

	it("disregards a malformed marker at exit 0 rather than suppressing the whole frontier", async () => {
		const out = await run([
			[PERMISSION, okOut("write")],
			[CHILDREN, okOut(`[{"number":${TICKET}}]`)],
			[
				TICKET_COMMENTS,
				okOut(commentsJson([{id: 1, body: "map-ticket: #9140 · investigation · 7f3a9c21"}])),
			],
			[TICKET_ISSUE, okOut(issueJson({number: TICKET}))],
			mapOk,
		]);
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.tickets).toEqual([]);
		expect(answer.disregarded).toEqual([
			{
				ticket: TICKET,
				reason: "malformed",
				detail: "the map-ticket marker is not `map-ticket: #<map> · <kind> · <nonce>`",
			},
		]);
	});

	it("disregards a marker naming another map, so a stranger's issue is visible not counted", async () => {
		const out = await run([
			[PERMISSION, okOut("write")],
			[CHILDREN, okOut(`[{"number":${TICKET}}]`)],
			[
				TICKET_COMMENTS,
				okOut(
					commentsJson([
						{id: 1, body: composeTicketMarker({map: 9999, kind: "research", nonce: NONCE})},
					]),
				),
			],
			[TICKET_ISSUE, okOut(issueJson({number: TICKET}))],
			mapOk,
		]);
		expect(JSON.parse(out.stdout).disregarded[0]).toMatchObject({reason: "foreign-map"});
	});

	it("disregards a marker from an author with no write permission", async () => {
		const out = await run([
			[PERMISSION, okOut("read")],
			[CHILDREN, okOut(`[{"number":${TICKET}}]`)],
			[TICKET_COMMENTS, okOut(commentsJson([{id: 1, body: marker, author: "stranger"}]))],
			[TICKET_ISSUE, okOut(issueJson({number: TICKET}))],
			mapOk,
		]);
		expect(JSON.parse(out.stdout).disregarded[0]).toMatchObject({reason: "unauthorized"});
	});

	it("counts an unmarked child as nothing at all — it is not a frontier ticket", async () => {
		const out = await run([
			[PERMISSION, okOut("write")],
			[CHILDREN, okOut(`[{"number":${TICKET}}]`)],
			[TICKET_COMMENTS, okOut(commentsJson([]))],
			[TICKET_ISSUE, okOut(issueJson({number: TICKET}))],
			mapOk,
		]);
		const answer = JSON.parse(out.stdout);
		expect(answer.tickets).toEqual([]);
		expect(answer.disregarded).toEqual([]);
		expect(answer.frontier).toBe("empty");
	});
});
