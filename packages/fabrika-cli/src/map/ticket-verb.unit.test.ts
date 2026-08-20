import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, once, type Scripted} from "../fakes.test-support.ts";
import {parseBody, renderFrontierRow, spliceSection} from "./body.ts";
import {
	ALREADY_DESCOPED,
	DIGEST_STALE,
	EDGE_UNRESOLVABLE,
	TICKET_UNKNOWN,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	commentsJson,
	digestFor,
	issueJson,
	MAP,
	MAP_BODY,
	MAP_BODY_WITH_REJECTION,
	NONCE,
	parsed,
	REPO,
	TICKET,
} from "./fixtures.test-support.ts";
import {composeTicketMarker} from "./markers.ts";
import {runTicket} from "./ticket-verb.ts";

const PERMISSION = /collaborators\/.*\/permission/;
const CHILDREN = /GET .*\/issues\/9140\/sub_issues/;
const TICKET_COMMENTS = /issues\/9142\/comments/;
const EDGES = /issues\/9142\/dependencies\//;
const TICKET_ISSUE = /issues\/9142$/;
const MAP_ISSUE = /issues\/9140$/;
const CREATE = /POST .*\/repos\/o\/r\/issues$/;
const POST_COMMENT = /POST .*\/issues\/9145\/comments/;
const NEW_ISSUE = /issues\/9145$/;
const LINK = /POST .*\/issues\/9140\/sub_issues/;
const PATCH = /PATCH .*\/issues\/9140/;

const served = (body: string) => ({status: 200, body}) as const;

const QUESTION = "does better-auth mint a single-use token without a new table?";

const options = {
	map: MAP,
	digest: digestFor(MAP_BODY),
	kind: "research",
	question: QUESTION,
	blocks: [] as ReadonlyArray<number>,
	blockedBy: [] as ReadonlyArray<number>,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: REPO},
	nonce: () => NONCE,
};

const run = (script: ReadonlyArray<Scripted>, over: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runTicket({...options, ...over}), fakeSeams(script).layer));

const mapOk = (body = MAP_BODY): Scripted => [
	MAP_ISSUE,
	served(issueJson({number: MAP, body, labels: ["wayfinding:map"]})),
];

const frontier: ReadonlyArray<Scripted> = [
	[PERMISSION, served('{"permission":"write"}')],
	[CHILDREN, served(`[{"number":${TICKET}}]`)],
	[
		TICKET_COMMENTS,
		served(
			commentsJson([
				{id: 1, body: composeTicketMarker({map: MAP, kind: "research", nonce: NONCE})},
			]),
		),
	],
	[EDGES, served("[]")],
	[TICKET_ISSUE, served(issueJson({number: TICKET, body: "which table carries it?"}))],
];

/** The body a successful file leaves: the fixture's row plus the new ticket's. */
const spliced = spliceSection(
	parsed(MAP_BODY),
	"Frontier",
	[
		...parsed(MAP_BODY).frontier.map(renderFrontierRow),
		renderFrontierRow({ticket: 9145, kind: "research", question: QUESTION, forkedTo: null}),
	].join("\n"),
);

describe("runTicket — the preconditions, all before anything is written", () => {
	it("exits 1 on an off-vocabulary kind, naming the whole set", async () => {
		const out = await run([], {kind: "investigation"});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("research, prototype, decision");
	});

	it("exits 12 with nothing on stdout when the body moved since --digest", async () => {
		const out = await run([mapOk()], {digest: "000000000000"});
		expect(out.code).toBe(DIGEST_STALE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("nothing was written");
	});

	it("exits 19 when the question restates a direction already recorded out of scope", async () => {
		const out = await run([mapOk(MAP_BODY_WITH_REJECTION)], {
			digest: digestFor(MAP_BODY_WITH_REJECTION),
			question: "a per-topic weight multiplier for moderation",
		});
		expect(out.code).toBe(ALREADY_DESCOPED);
		expect(out.stderr.join("\n")).toContain("nothing was written");
	});

	it("exits 13 when an edge target is not a ticket of this map", async () => {
		const out = await run([...frontier, mapOk()], {blockedBy: [9999]});
		expect(out.code).toBe(TICKET_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 14 on an edge that would close a cycle, naming the loop", async () => {
		const out = await run([...frontier, mapOk()], {blockedBy: [TICKET], blocks: [TICKET]});
		expect(out.code).toBe(EDGE_UNRESOLVABLE);
		expect(out.stderr.join("\n")).toContain("no run can drain");
	});

	// The frontier's issue payload carries no `id`, so the edge target's internal id is unresolvable
	// off the very read that answers everything else about it.
	it("exits 14 when an edge target's internal id cannot be resolved, before the create", async () => {
		const seams = fakeSeams([...frontier, mapOk()]);
		const out = await Effect.runPromise(
			Effect.provide(runTicket({...options, blockedBy: [TICKET]}), seams.layer),
		);
		expect(out.code).toBe(EDGE_UNRESOLVABLE);
		expect(out.stderr.join("\n")).toContain("nothing was written");
		expect(seams.requests.some((line) => line.startsWith("POST"))).toBe(false);
	});
});

describe("runTicket — the write order", () => {
	const created: Scripted = [
		CREATE,
		{status: 201, body: '{"number":9145,"html_url":"https://github.com/o/r/issues/9145"}'},
	];

	it("exits 8 naming the number when the marker does not land — the issue is inert, not half-present", async () => {
		const out = await run([
			created,
			[POST_COMMENT, {status: 502, body: "{}"}],
			...frontier,
			mapOk(),
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("Re-run with the same question to resume");
	});

	it("exits 8 naming the number when the sub-issue link does not land", async () => {
		const out = await run([
			created,
			[POST_COMMENT, {status: 201, body: '{"id":1,"html_url":"u"}'}],
			[NEW_ISSUE, served('{"id":55}')],
			[LINK, {status: 502, body: "{}"}],
			...frontier,
			mapOk(),
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("Link it before charting on");
	});

	it("exits 0 with the ticket, its edges and the map's NEW digest", async () => {
		const seams = fakeSeams([
			created,
			[POST_COMMENT, {status: 201, body: '{"id":1,"html_url":"u"}'}],
			[NEW_ISSUE, served('{"id":55}')],
			[LINK, served("{}")],
			[PATCH, served("{}")],
			...frontier,
			[
				once(MAP_ISSUE),
				served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[
				once(MAP_ISSUE),
				served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, served(issueJson({number: MAP, body: spliced, labels: ["wayfinding:map"]}))],
		]);
		const out = await Effect.runPromise(Effect.provide(runTicket(options), seams.layer));
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer).toMatchObject({map: MAP, ticket: 9145, kind: "research"});
		expect(answer.digest).not.toBe(options.digest);
		// The body write is last, so it spends the shortest time between the guard and the write.
		const patchAt = seams.requests.findIndex((line) => line.startsWith("PATCH"));
		const linkAt = seams.requests.findIndex(
			(line) => line.startsWith("POST") && line.includes("/sub_issues"),
		);
		expect(patchAt).toBeGreaterThan(linkAt);
	});

	it("splices the row onto the map without disturbing the other sections", () => {
		const body = parseBody(spliced);
		expect(body._tag).toBe("Parsed");
		expect(body._tag === "Parsed" && body.value.frontier.map((row) => row.ticket)).toEqual([
			TICKET,
			9145,
		]);
		expect(body._tag === "Parsed" && body.value.fog).toBe(1);
	});
});
