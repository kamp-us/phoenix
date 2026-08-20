import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {
	BAD_SECTIONS,
	KIND_MISMATCH,
	LANE_NOT_MINE,
	LEAKED_PATH,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {runFinding} from "./finding-verb.ts";
import {
	commentsJson,
	issueJson,
	MAP,
	MAP_BODY,
	NONCE,
	REPO,
	TICKET,
} from "./fixtures.test-support.ts";
import {composeFindingMarker, composeLaneMarker, composeTicketMarker} from "./markers.ts";

const POST = /POST .*\/issues\/9142\/comments/;
const GET_COMMENT = /issues\/comments\/\d+/;
const PERMISSION = /collaborators\/.*\/permission/;
const CHILDREN = /issues\/9140\/sub_issues/;
const TICKET_COMMENTS = /issues\/9142\/comments/;
const EDGES = /issues\/9142\/dependencies\//;
const TICKET_ISSUE = /issues\/9142$/;
const MAP_ISSUE = /issues\/9140$/;

const served = (body: string) => ({status: 200, body}) as const;

const FINDING_PATH = "finding.md";

const options = {
	map: MAP,
	ticket: TICKET,
	nonce: NONCE,
	outcome: "no-evidence",
	finding: null as string | null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: REPO},
};

const run = (
	script: ReadonlyArray<Scripted>,
	over: Partial<typeof options> = {},
	files: Readonly<Record<string, string | null>> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runFinding({...options, ...over}),
			Layer.merge(fakeSeams(script).layer, fakeFs({files}).layer),
		),
	);

const held = (nonce = NONCE): ReadonlyArray<Scripted> => [
	[PERMISSION, served('{"permission":"write"}')],
	[CHILDREN, served(`[{"number":${TICKET}}]`)],
	[
		TICKET_COMMENTS,
		served(
			commentsJson([
				{id: 1, body: composeTicketMarker({map: MAP, kind: "research", nonce: NONCE})},
				{id: 2, body: composeLaneMarker({map: MAP, ticket: TICKET, nonce})},
			]),
		),
	],
	[EDGES, served("[]")],
	[TICKET_ISSUE, served(issueJson({number: TICKET, body: "which table?"}))],
	[MAP_ISSUE, served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]}))],
];

describe("runFinding — the outcome vocabulary", () => {
	it("exits 1 on an off-vocabulary outcome, naming the three", async () => {
		const out = await run([], {outcome: "none"});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("answered, no-evidence, unreachable");
	});

	it("exits 4 when --outcome answered arrives with no finding", async () => {
		const out = await run([], {outcome: "answered"});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("indistinguishable from one that found nothing");
	});

	it("exits 4 on an empty finding file — an empty finding is not an answer", async () => {
		const out = await run(
			[],
			{outcome: "answered", finding: FINDING_PATH},
			{[FINDING_PATH]: "  \n"},
		);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.join("\n")).toContain("use --outcome no-evidence");
	});

	it("exits 1 on a finding file that cannot be read — the finding is UNKNOWN, never empty", async () => {
		const out = await run([], {outcome: "answered", finding: FINDING_PATH}, {});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("UNKNOWN, never empty");
	});

	it("exits 5 on a finding carrying a machine-local path", async () => {
		const out = await run(
			[],
			{outcome: "answered", finding: FINDING_PATH},
			{[FINDING_PATH]: "the evidence is in ~/notes/weight.md\n"},
		);
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stdout).toBe("");
	});
});

describe("runFinding — the lane", () => {
	it("exits 0, records the outcome and releases the lane", async () => {
		const body = `${composeFindingMarker({map: MAP, ticket: TICKET, outcome: "no-evidence", nonce: NONCE})}\n`;
		const out = await run([
			[POST, {status: 201, body: '{"id":77,"html_url":"u"}'}],
			[GET_COMMENT, served(JSON.stringify({body}))],
			...held(),
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			map: MAP,
			ticket: TICKET,
			outcome: "no-evidence",
			comment: 77,
			lane: "released",
		});
	});

	it("exits 15 when a different nonce holds the lane", async () => {
		const out = await run([...held("bbbbbbbb")]);
		expect(out.code).toBe(LANE_NOT_MINE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("nothing was recorded");
	});

	it("exits 15 when no lane is held at all — the state is named rather than guessed", async () => {
		const out = await run([
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
			[TICKET_ISSUE, served(issueJson({number: TICKET}))],
			[MAP_ISSUE, served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]}))],
		]);
		expect(out.code).toBe(LANE_NOT_MINE);
		expect(out.stderr.join("\n")).toContain("the ticket reads open");
	});

	it("exits 20 on a decision ticket — a decision has no lane", async () => {
		const out = await run([
			[PERMISSION, served('{"permission":"write"}')],
			[CHILDREN, served(`[{"number":${TICKET}}]`)],
			[
				TICKET_COMMENTS,
				served(
					commentsJson([
						{id: 1, body: composeTicketMarker({map: MAP, kind: "decision", nonce: NONCE})},
					]),
				),
			],
			[EDGES, served("[]")],
			[TICKET_ISSUE, served(issueJson({number: TICKET}))],
			[MAP_ISSUE, served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]}))],
		]);
		expect(out.code).toBe(KIND_MISMATCH);
		expect(out.stdout).toBe("");
	});

	it("never touches the map body — lane traffic goes to the ticket", async () => {
		const body = `${composeFindingMarker({map: MAP, ticket: TICKET, outcome: "no-evidence", nonce: NONCE})}\n`;
		const seams = fakeSeams([
			[POST, {status: 201, body: '{"id":77,"html_url":"u"}'}],
			[GET_COMMENT, served(JSON.stringify({body}))],
			...held(),
		]);
		await Effect.runPromise(
			Effect.provide(runFinding(options), Layer.merge(seams.layer, fakeFs({}).layer)),
		);
		expect(seams.requests.some((line) => line.startsWith("PATCH"))).toBe(false);
	});

	it("exits 8 when the comment write fails, and 9 when it does not read back", async () => {
		const failed = await run([[POST, {status: 502, body: "{}"}], ...held()]);
		expect(failed.code).toBe(WRITE_UNKNOWN);
		expect(failed.stdout).toBe("");
		const drifted = await run([
			[POST, {status: 201, body: '{"id":77,"html_url":"u"}'}],
			[GET_COMMENT, served(JSON.stringify({body: "not the marker"}))],
			...held(),
		]);
		expect(drifted.code).toBe(READBACK_MISMATCH);
		expect(drifted.stdout).toBe("");
	});
});
