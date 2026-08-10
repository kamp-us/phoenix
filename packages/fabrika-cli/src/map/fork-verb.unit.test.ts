import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {renderFrontierRow, spliceSection} from "./body.ts";
import {DIGEST_STALE, KIND_MISMATCH, TICKET_UNKNOWN} from "./codes.ts";
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
import {runFork, SESSION_LABEL} from "./fork-verb.ts";
import {composeForkMarker, composeTicketMarker} from "./markers.ts";

const POST = /--method POST repos\/o\/r\/issues\/9142\/comments/;
const GET_COMMENT = /issues\/comments\/\d+/;
const PERMISSION = /collaborators\/.*\/permission/;
const CHILDREN = /issues\/9140\/sub_issues/;
const TICKET_COMMENTS = /issues\/9142\/comments/;
const EDGES = /issues\/9142\/dependencies\//;
const TICKET_ISSUE = /issues\/9142$/;
const MAP_ISSUE = /issues\/9140$/;
const SESSION_ISSUE = /issues\/9301$/;
const PATCH = /--method PATCH repos\/o\/r\/issues\/9140/;

const options = {
	map: MAP,
	digest: digestFor(MAP_BODY),
	ticket: TICKET,
	session: 9301 as number | null,
	spike: null as number | null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: REPO},
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	over: Partial<typeof options> = {},
) => Effect.runPromise(Effect.provide(runFork({...options, ...over}), fakeShell(script).layer));

const frontier = (kind: "research" | "prototype" | "decision") =>
	[
		[PERMISSION, okOut("write")],
		[CHILDREN, okOut(`[{"number":${TICKET}}]`)],
		[
			TICKET_COMMENTS,
			okOut(commentsJson([{id: 1, body: composeTicketMarker({map: MAP, kind, nonce: NONCE})}])),
		],
		[EDGES, okOut("[]")],
		[
			TICKET_ISSUE,
			okOut(issueJson({number: TICKET, body: "does an invited çaylak start at 0 karma?"})),
		],
	] as const;

const mapOk = [
	MAP_ISSUE,
	okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
] as const;

const forked = spliceSection(
	parsed(MAP_BODY),
	"Frontier",
	parsed(MAP_BODY)
		.frontier.map((row) => renderFrontierRow({...row, forkedTo: 9301}))
		.join("\n"),
);

describe("runFork", () => {
	it("exits 12 when the body moved since --digest", async () => {
		const out = await run([mapOk], {digest: "000000000000"});
		expect(out.code).toBe(DIGEST_STALE);
		expect(out.stdout).toBe("");
	});

	it("exits 20 on a research ticket, which is laned rather than routed", async () => {
		const out = await run([...frontier("research"), mapOk]);
		expect(out.code).toBe(KIND_MISMATCH);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("resolve it in a lane");
	});

	it("exits 20 when the kind admits --spike and --session was given", async () => {
		const out = await run([...frontier("prototype"), mapOk]);
		expect(out.code).toBe(KIND_MISMATCH);
		expect(out.stderr.join("\n")).toContain("takes --spike");
	});

	it("exits 20 when neither route flag was given", async () => {
		const out = await run([...frontier("decision"), mapOk], {session: null});
		expect(out.code).toBe(KIND_MISMATCH);
		expect(out.stderr.join("\n")).toContain("neither was given");
	});

	it("exits 13 when --session is not a grilling session", async () => {
		const out = await run([
			[SESSION_ISSUE, okOut(issueJson({number: 9301}))],
			...frontier("decision"),
			mapOk,
		]);
		expect(out.code).toBe(TICKET_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("no grilling run will read");
	});

	it("exits 0, marks the ticket and renders the route onto the row", async () => {
		const marker = composeForkMarker({map: MAP, ticket: TICKET, route: "session", issue: 9301});
		const out = await run([
			[POST, okOut('{"id":9,"html_url":"u"}')],
			[GET_COMMENT, okOut(JSON.stringify({body: marker}))],
			[SESSION_ISSUE, okOut(issueJson({number: 9301, labels: [SESSION_LABEL]}))],
			[PATCH, okOut("{}")],
			...frontier("decision"),
			[
				once(MAP_ISSUE),
				okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[
				once(MAP_ISSUE),
				okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, okOut(issueJson({number: MAP, body: forked, labels: ["wayfinding:map"]}))],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			map: MAP,
			ticket: TICKET,
			session: 9301,
			state: "forked",
		});
	});

	it("records where the decision is being made and never the decision itself", async () => {
		const marker = composeForkMarker({map: MAP, ticket: TICKET, route: "session", issue: 9301});
		const shell = fakeShell([
			[POST, okOut('{"id":9,"html_url":"u"}')],
			[GET_COMMENT, okOut(JSON.stringify({body: marker}))],
			[SESSION_ISSUE, okOut(issueJson({number: 9301, labels: [SESSION_LABEL]}))],
			[PATCH, okOut("{}")],
			...frontier("decision"),
			[
				once(MAP_ISSUE),
				okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[
				once(MAP_ISSUE),
				okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, okOut(issueJson({number: MAP, body: forked, labels: ["wayfinding:map"]}))],
		]);
		await Effect.runPromise(Effect.provide(runFork(options), shell.layer));
		const patch = shell.calls.find((line) => line.includes("--method PATCH")) ?? "";
		expect(patch).not.toContain("## Decisions\n-");
		expect(patch).toContain("forked to #9301");
	});
});
