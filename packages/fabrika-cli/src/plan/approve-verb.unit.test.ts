import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {HttpReply} from "../fakes.test-support.ts";
import {read as readApproval} from "../wire/plan-approval.ts";
import {runApprove} from "./approve-verb.ts";
import {APPROVAL_UNAUTHORIZED, PRECONDITION_UNKNOWN, READBACK_MISMATCH} from "./codes.ts";
import {
	CHILD as CHILD_AT,
	CWD,
	CYCLE_DOC,
	child,
	cycleDoc,
	digestOver,
	ENV as env,
	epic,
	epicBody,
	planSeams,
	type Scripted,
	SUB_ISSUES,
	subIssues,
} from "./fixtures.test-support.ts";

const API = "https:\\/\\/api\\.github\\.com";
const EPIC = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/issues\\/4300$`);
const SUBS = SUB_ISSUES;
const CHILD = CHILD_AT(4301);
const CYCLE = CYCLE_DOC;
const VIEWER = new RegExp(`^GET ${API}\\/user$`);
const TRUNK = new RegExp(`^GET ${API}\\/repos\\/o\\/r$`);
const CODEOWNERS = /contents\/\.github\/CODEOWNERS\?ref=main$/;
const MEMBERS = new RegExp(`^GET ${API}\\/orgs\\/kamp-us\\/teams\\/control-plane\\/members`);
const POST = new RegExp(`^POST ${API}\\/repos\\/o\\/r\\/issues\\/4300\\/comments$`);
const GET_COMMENT = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/issues\\/comments\\/512346$`);

const NOW = () => new Date("2026-08-16T07:16:03.500Z");

const served = (body: unknown): HttpReply => ({status: 200, body: JSON.stringify(body)});

const ledger: ReadonlyArray<Scripted> = [
	[EPIC, epic({body: epicBody({dependencies: "- phase 1: #4301"})})],
	[SUBS, subIssues(4301)],
	[CHILD, child({number: 4301})],
	[CYCLE, cycleDoc],
];

const acl: ReadonlyArray<Scripted> = [
	[VIEWER, served({login: "usirin"})],
	[TRUNK, served({default_branch: "main"})],
	[CODEOWNERS, {status: 200, body: "/packages/fabrika-cli/ @kamp-us/control-plane\n"}],
	[MEMBERS, served([{login: "usirin"}, {login: "cansirin"}])],
];

const POSTED: HttpReply = {
	status: 201,
	body: JSON.stringify({id: 512346, html_url: "https://github.com/o/r/issues/4300#c"}),
};

const run = (script: ReadonlyArray<Scripted>) => {
	const seams = planSeams(script);
	return Effect.runPromise(
		Effect.provide(runApprove({number: 4300, repo: null, env, cwd: CWD, now: NOW}), seams.layer),
	).then((outcome) => ({outcome, calls: seams.http.calls, bodies: seams.http.bodies}));
};

/** The bytes the verb posted — the marker travels as the request body's `body` field now. */
const postedBody = (posted: {
	calls: ReadonlyArray<string>;
	bodies: ReadonlyArray<string>;
}): string => {
	const at = posted.calls.findIndex((line) => POST.test(line));
	if (at < 0) return "";
	const sent: unknown = JSON.parse(posted.bodies[at] ?? "{}");
	return typeof sent === "object" && sent !== null && "body" in sent
		? String((sent as {body: unknown}).body)
		: "";
};

const derivedDigest = (): Promise<string> => digestOver(ledger, {env});

describe("runApprove", () => {
	it("posts a marker bound to the digest it derived itself and reads it back", async () => {
		const digest = await derivedDigest();
		const first = await run([...ledger, ...acl, [POST, POSTED]]);
		const body = postedBody(first);
		const {outcome} = await run([...ledger, ...acl, [POST, POSTED], [GET_COMMENT, served({body})]]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "approved",
			epic: 4300,
			digest,
			by: "usirin",
			at: "2026-08-16T07:16:03Z",
			comment: 512346,
		});
	});

	/**
	 * The invariant the verb exists for: the posted digest is `scopeDigest`'s answer over the ledger
	 * as it stands, and no flag can supply another. `plan approve --help` declares two options, and
	 * neither is `--digest`.
	 */
	it("posts the freshly derived digest, and exposes no flag to supply one", async () => {
		const digest = await derivedDigest();
		const posted = await run([...ledger, ...acl, [POST, POSTED]]);
		const marked = readApproval(postedBody(posted));
		expect(marked._tag).toBe("Found");
		if (marked._tag !== "Found") return;
		expect(marked.value).toEqual({epic: 4300, digest, at: "2026-08-16T07:16:03Z"});
	});

	it("refuses 24 when the invoking account is not on the roster, and posts nothing", async () => {
		const {outcome, calls} = await run([
			[VIEWER, served({login: "someone-else"})],
			...ledger,
			...acl,
			[POST, POSTED],
		]);
		expect(outcome.code).toBe(APPROVAL_UNAUTHORIZED);
		expect(outcome.stderr.at(-1)).toContain("is not on o/r's control-plane roster at main");
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses 24 when CODEOWNERS names no control-plane owner at all", async () => {
		const {outcome, calls} = await run([
			[CODEOWNERS, {status: 200, body: "# nobody owns anything\n"}],
			...ledger,
			...acl,
			[POST, POSTED],
		]);
		expect(outcome.code).toBe(APPROVAL_UNAUTHORIZED);
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});

	/**
	 * The #4223 collapse, refused: a roster nobody could read is neither "approved" nor "not
	 * approved". Both readings are wrong and the exit code is the one that says so.
	 */
	it("refuses 11 on a failed roster read — neither approved nor unapproved", async () => {
		const {outcome, calls} = await run([
			[MEMBERS, {status: 502, body: '{"message":"Bad gateway"}'}],
			...ledger,
			...acl,
			[POST, POSTED],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.code).not.toBe(APPROVAL_UNAUTHORIZED);
		const said = outcome.stderr.at(-1) ?? "";
		expect(said).toContain("UNKNOWN, neither approved nor unapproved");
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses 11 when the CODEOWNERS read fails, and posts nothing", async () => {
		const {outcome, calls} = await run([
			[CODEOWNERS, {status: 500, body: '{"message":"Server error"}'}],
			...ledger,
			...acl,
			[POST, POSTED],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses 9 when the marker posts and does not read back", async () => {
		const {outcome} = await run([
			...ledger,
			...acl,
			[POST, POSTED],
			[GET_COMMENT, served({body: "plan-approved: #4300 @ ffffffffffff · x\n"})],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});
});
