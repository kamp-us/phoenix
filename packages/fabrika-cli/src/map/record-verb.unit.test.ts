import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	BAD_SECTIONS,
	OUTCOME_UNRECORDABLE,
	PRECONDITION_UNKNOWN,
	TICKET_UNKNOWN,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	commentsJson,
	digestFor,
	issueJson,
	MAP,
	MAP_BODY,
	NONCE,
	parsed,
	REPO,
	TICKET,
} from "./fixtures.test-support.ts";
import {
	composeFindingMarker,
	composeForkMarker,
	composeLaneMarker,
	composeTicketMarker,
} from "./markers.ts";
import {applyRecord} from "./record.ts";
import {runRecord} from "./record-verb.ts";

const PERMISSION = /collaborators\/.*\/permission/;
const CHILDREN = /issues\/9140\/sub_issues/;
const TICKET_COMMENTS = /issues\/9142\/comments/;
const EDGES = /issues\/9142\/dependencies\//;
const TICKET_ISSUE = /issues\/9142$/;
const MAP_ISSUE = /issues\/9140$/;
const PATCH_MAP = /--method PATCH repos\/o\/r\/issues\/9140/;
const PATCH_TICKET = /--method PATCH repos\/o\/r\/issues\/9142/;

const FINDING = "finding.md";
const ANSWER = "the weight column lives on the account row";

const options = {
	map: MAP,
	digest: digestFor(MAP_BODY),
	ticket: TICKET,
	finding: FINDING,
	ruledOn: null as number | null,
	spike: null as number | null,
	questionId: null as string | null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: REPO},
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	over: Partial<typeof options> = {},
	files: Readonly<Record<string, string | null>> = {[FINDING]: `${ANSWER}\n`},
) =>
	Effect.runPromise(
		Effect.provide(
			runRecord({...options, ...over}),
			Layer.merge(fakeShell(script).layer, fakeFs({files}).layer),
		),
	);

const ticketComments = (
	extra: ReadonlyArray<{readonly id: number; readonly body: string}> = [],
	kind: "research" | "decision" | "prototype" = "research",
) => commentsJson([{id: 1, body: composeTicketMarker({map: MAP, kind, nonce: NONCE})}, ...extra]);

const frontier = (comments: string) =>
	[
		[PERMISSION, okOut("write")],
		[CHILDREN, okOut(`[{"number":${TICKET}}]`)],
		[TICKET_COMMENTS, okOut(comments)],
		[EDGES, okOut("[]")],
		[TICKET_ISSUE, okOut(issueJson({number: TICKET, body: "which table carries it?"}))],
	] as const;

const laneClosed = (outcome: "answered" | "no-evidence" | "unreachable") =>
	ticketComments([
		{id: 2, body: composeLaneMarker({map: MAP, ticket: TICKET, nonce: NONCE})},
		{id: 3, body: composeFindingMarker({map: MAP, ticket: TICKET, outcome, nonce: NONCE})},
	]);

const recorded = applyRecord(parsed(MAP_BODY), TICKET, {
	text: ANSWER,
	authority: {_tag: "Finding", ticket: TICKET},
}) as string;

describe("runRecord", () => {
	it("exits 1 when --ruled-on arrives without a well-formed --question-id", async () => {
		const out = await run([], {ruledOn: 9301, questionId: "2.3"});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
	});

	it("exits 4 on an empty finding", async () => {
		const out = await run([], {}, {[FINDING]: "\n"});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
	});

	it("exits 21 when the lane returned unreachable — there is no answer to record", async () => {
		const out = await run([
			...frontier(laneClosed("unreachable")),
			[MAP_ISSUE, okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]}))],
		]);
		expect(out.code).toBe(OUTCOME_UNRECORDABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("map descope --ticket");
	});

	it("exits 13 when a forked decision arrives with no --ruled-on", async () => {
		const out = await run([
			...frontier(
				ticketComments(
					[
						{
							id: 2,
							body: composeForkMarker({map: MAP, ticket: TICKET, route: "session", issue: 9301}),
						},
					],
					"decision",
				),
			),
			[MAP_ISSUE, okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]}))],
		]);
		expect(out.code).toBe(TICKET_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("never by restating it");
	});

	it("exits 11 on a forked decision until the grill reader lands — never assumed ruled", async () => {
		const out = await run(
			[
				...frontier(
					ticketComments(
						[
							{
								id: 2,
								body: composeForkMarker({map: MAP, ticket: TICKET, route: "session", issue: 9301}),
							},
						],
						"decision",
					),
				),
				[MAP_ISSUE, okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]}))],
			],
			{ruledOn: 9301, questionId: "R2.3"},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("Nothing was recorded");
	});

	it("exits 0 on a research finding, moving the row and closing the ticket in that order", async () => {
		const shell = fakeShell([
			[PATCH_TICKET, okOut("{}")],
			[PATCH_MAP, okOut("{}")],
			...frontier(laneClosed("answered")),
			[
				once(MAP_ISSUE),
				okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, okOut(issueJson({number: MAP, body: recorded, labels: ["wayfinding:map"]}))],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runRecord(options),
				Layer.merge(shell.layer, fakeFs({files: {[FINDING]: `${ANSWER}\n`}}).layer),
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			map: MAP,
			ticket: TICKET,
			recorded: `— from #${TICKET}`,
			closed: true,
		});
		const bodyAt = shell.calls.findIndex((line) => line.includes("PATCH repos/o/r/issues/9140"));
		const closeAt = shell.calls.findIndex((line) => line.includes("state_reason=completed"));
		// The close is second so the surviving half of a partial application is the re-runnable one.
		expect(closeAt).toBeGreaterThan(bodyAt);
	});

	it("moves the answer and the row in ONE body PATCH, so the two cannot separate", async () => {
		const shell = fakeShell([
			[PATCH_TICKET, okOut("{}")],
			[PATCH_MAP, okOut("{}")],
			...frontier(laneClosed("answered")),
			[
				once(MAP_ISSUE),
				okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, okOut(issueJson({number: MAP, body: recorded, labels: ["wayfinding:map"]}))],
		]);
		await Effect.runPromise(
			Effect.provide(
				runRecord(options),
				Layer.merge(shell.layer, fakeFs({files: {[FINDING]: `${ANSWER}\n`}}).layer),
			),
		);
		const patches = shell.calls.filter((line) => line.includes("PATCH repos/o/r/issues/9140"));
		expect(patches).toHaveLength(1);
		expect(patches[0]).toContain(`— from #${TICKET}`);
		expect(patches[0]).not.toContain(`- #${TICKET} · research`);
	});

	it("exits 8 naming the ticket when the close does not land — the visible half is the survivor", async () => {
		const out = await run([
			[PATCH_TICKET, errOut("gh: Bad gateway (HTTP 502)")],
			[PATCH_MAP, okOut("{}")],
			...frontier(laneClosed("answered")),
			[
				once(MAP_ISSUE),
				okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, okOut(issueJson({number: MAP, body: recorded, labels: ["wayfinding:map"]}))],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain(`Close #${TICKET} by hand`);
	});
});
