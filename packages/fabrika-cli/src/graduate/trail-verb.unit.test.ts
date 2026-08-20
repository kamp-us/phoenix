import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {BAD_SECTIONS, NO_TARGET, PRECONDITION_UNKNOWN, SOURCE_UNRECOGNIZED} from "./codes.ts";
import {
	CLEARED_DECISIONS,
	CLEARED_SESSION,
	commentsPayload,
	issueJson,
	MAP,
	MAP_BODY,
	REPO,
	ROUND,
	SESSION,
} from "./fixtures.test-support.ts";
import {digestOfDecisions} from "./trail.ts";
import {runTrail} from "./trail-verb.ts";

const SESSION_ISSUE = /^GET .*\/repos\/o\/r\/issues\/9412$/;
const SESSION_COMMENTS = /^GET .*\/repos\/o\/r\/issues\/9412\/comments\?/;
const PERMISSION = /collaborators\/.*\/permission/;
const MAP_ISSUE = /^GET .*\/repos\/o\/r\/issues\/9140$/;
const CHILDREN = /issues\/9140\/sub_issues/;
const TICKET_ISSUE = /^GET .*\/issues\/9142$/;
const TICKET_COMMENTS = /issues\/9142\/comments/;
const BLOCKED_BY = /issues\/9142\/dependencies\/blocked_by/;
const BLOCKING = /issues\/9142\/dependencies\/blocking/;

/** A served 200 — every read below asks for JSON and gets a whole single page. */
const served = (body: string): HttpReply => ({status: 200, body});

const run = (source: number, script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(
		Effect.provide(
			runTrail({source, repo: null, env: {CLAUDE_PIPELINE_REPO: REPO}}),
			fakeSeams(script).layer,
		),
	);

const session = (labels: ReadonlyArray<string> = ["grilling:session"]) =>
	[SESSION_ISSUE, served(issueJson({number: SESSION, labels}))] as const;

describe("a grilling source resolves through the grill reader", () => {
	it("answers `ready` at exit 0 with both provenance words and the trail digest", async () => {
		const out = await run(SESSION, [
			session(),
			[SESSION_COMMENTS, served(commentsPayload([...CLEARED_SESSION]))],
			[PERMISSION, served(JSON.stringify({permission: "write"}))],
		]);
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer).toMatchObject({
			source: SESSION,
			kind: "grilling",
			readiness: "ready",
			outOfScope: [],
			counts: {ruled: 1, established: 1, unresolved: 0},
		});
		expect(answer.decisions).toEqual(CLEARED_DECISIONS);
		expect(answer.trailDigest).toBe(digestOfDecisions(CLEARED_DECISIONS));
	});

	it("answers `blocked` at exit 0, carrying the resolver's own state word", async () => {
		const out = await run(SESSION, [
			session(),
			[SESSION_COMMENTS, served(commentsPayload([ROUND]))],
			[PERMISSION, served(JSON.stringify({permission: "write"}))],
		]);
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.readiness).toBe("blocked");
		expect(answer.unresolved).toEqual([
			{ref: "R1.1", state: "open"},
			{ref: "R1.2", state: "open"},
		]);
	});

	it("answers `empty` at exit 0 on a session with nothing on it — zero decisions is a fact", async () => {
		const out = await run(SESSION, [session(), [SESSION_COMMENTS, served("[]")]]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({readiness: "empty", decisions: [], counts: {}});
	});
});

describe("the digest is neutral to every write this group makes", () => {
	it("recomputes byte-identically after an emission marker has landed on the source", async () => {
		const before = JSON.parse(
			(
				await run(SESSION, [
					session(),
					[SESSION_COMMENTS, served(commentsPayload([...CLEARED_SESSION]))],
					[PERMISSION, served(JSON.stringify({permission: "write"}))],
				])
			).stdout,
		);
		const after = JSON.parse(
			(
				await run(SESSION, [
					session(),
					[
						SESSION_COMMENTS,
						served(
							commentsPayload([
								...CLEARED_SESSION,
								{
									id: 9,
									author: "acme-founder",
									body: `graduate-emitted: #9412 → #9520 @ ${digestOfDecisions(CLEARED_DECISIONS)} · covers R1.1;R1.2 · 2026-08-09T18:36:48Z\n`,
								},
							]),
						),
					],
					[PERMISSION, served(JSON.stringify({permission: "write"}))],
				])
			).stdout,
		);
		expect(after.trailDigest).toBe(before.trailDigest);
		expect(after.decisions).toEqual(before.decisions);
	});
});

describe("a map source resolves through the map module, not through `map read`'s stdout", () => {
	const mapHealthy = [
		[MAP_ISSUE, served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]}))],
		[CHILDREN, served('[{"number":9142}]')],
		[TICKET_ISSUE, served(issueJson({number: 9142, body: "which table carries it?"}))],
		[
			TICKET_COMMENTS,
			served(
				'[{"id":1,"body":"map-ticket: #9140 · research · 7f3a9c21","user":{"login":"acme-founder"},"created_at":"2026-08-10T00:00:00Z","updated_at":"2026-08-10T00:00:00Z"}]',
			),
		],
		[BLOCKED_BY, served("[]")],
		[BLOCKING, served("[]")],
		[PERMISSION, served(JSON.stringify({permission: "write"}))],
	] as const;

	it("takes its decisions from the body's `## Decisions` section, with the citations as refs", async () => {
		const out = await run(MAP, [...mapHealthy]);
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.kind).toBe("map");
		expect(answer.decisions).toEqual([
			{
				ref: "#9301 R1.2",
				provenance: "ruled",
				text: "Weight is earned per account, never inherited from a kefil.",
			},
			{
				ref: "#9505",
				provenance: "established",
				text: "The vote table has no per-account weight column today.",
			},
		]);
	});

	it("reads an open ticket as unresolved, so the trail is blocked", async () => {
		const answer = JSON.parse((await run(MAP, [...mapHealthy])).stdout);
		expect(answer.readiness).toBe("blocked");
		expect(answer.unresolved).toEqual([{ref: "#9142", state: "open"}]);
	});

	it("carries the map's out-of-scope entries through", async () => {
		const answer = JSON.parse((await run(MAP, [...mapHealthy])).stdout);
		expect(answer.outOfScope).toEqual([
			{
				direction: "a per-topic weight multiplier",
				reason: "It makes every action's authority unreadable",
				recordedAt: "2026-06-29",
			},
		]);
	});

	it("refuses a body that does not parse as PROVEN malformed, never unknown", async () => {
		const out = await run(MAP, [
			[
				MAP_ISSUE,
				served(issueJson({number: MAP, body: "## Fog\nnothing", labels: ["wayfinding:map"]})),
			],
		]);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
	});
});

describe("the dispatch refuses rather than guesses", () => {
	it("refuses an issue carrying neither label", async () => {
		const out = await run(SESSION, [session([])]);
		expect(out.code).toBe(SOURCE_UNRECOGNIZED);
		expect(out.stderr.join("\n")).toContain("neither grilling:session nor wayfinding:map");
	});

	it("refuses an issue carrying BOTH labels, naming both", async () => {
		const out = await run(SESSION, [session(["grilling:session", "wayfinding:map"])]);
		expect(out.code).toBe(SOURCE_UNRECOGNIZED);
		expect(out.stderr.join("\n")).toContain("refusing to guess which trail is live");
	});

	it("refuses a source that does not exist", async () => {
		const out = await run(SESSION, [
			[SESSION_ISSUE, {status: 404, body: '{"message":"Not Found"}'}],
		]);
		expect(out.code).toBe(NO_TARGET);
		expect(out.stdout).toBe("");
	});
});

describe("a read that could not complete is UNKNOWN, never an empty trail", () => {
	it("seats a failed comment read on 11 with nothing on stdout", async () => {
		const out = await run(SESSION, [session(), [SESSION_COMMENTS, {status: 502, body: "{}"}]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("never empty and never ready");
	});

	it("seats a failed ACL read on 11, saying a ruling's authority is never granted by it", async () => {
		const out = await run(SESSION, [
			session(),
			[SESSION_COMMENTS, served(commentsPayload([...CLEARED_SESSION]))],
			[PERMISSION, {status: 502, body: "{}"}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("UNKNOWN, never granted");
	});
});
