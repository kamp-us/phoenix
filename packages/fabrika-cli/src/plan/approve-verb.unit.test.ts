import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {read as readApproval} from "../wire/plan-approval.ts";
import {runApprove} from "./approve-verb.ts";
import {APPROVAL_UNAUTHORIZED, PRECONDITION_UNKNOWN, READBACK_MISMATCH} from "./codes.ts";
import {
	CWD,
	child,
	digestOver,
	epic,
	epicBody,
	planContext,
	subIssues,
} from "./fixtures.test-support.ts";

const EPIC = /^gh api repos\/o\/r\/issues\/4300$/;
const SUBS = /^gh api --paginate repos\/o\/r\/issues\/4300\/sub_issues/;
const CHILD = /^gh api repos\/o\/r\/issues\/4301$/;
const CYCLE = /^gh api repos\/o\/r\/contents\/product-development-cycle\.md$/;
const VIEWER = /^gh api user --jq \.login$/;
const TRUNK = /^gh api repos\/o\/r --jq \.default_branch$/;
const CODEOWNERS = /contents\/\.github\/CODEOWNERS\?ref=main$/;
const MEMBERS = /^gh api --paginate orgs\/kamp-us\/teams\/control-plane\/members/;
const POST = /^gh api --method POST repos\/o\/r\/issues\/4300\/comments/;
const GET_COMMENT = /^gh api repos\/o\/r\/issues\/comments\/512346$/;

const env = {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>;
const NOW = () => new Date("2026-08-16T07:16:03.500Z");

const ledger: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[EPIC, epic({body: epicBody({dependencies: "- phase 1: #4301"})})],
	[SUBS, subIssues(4301)],
	[CHILD, child({number: 4301})],
	[CYCLE, okOut("{}")],
];

const acl: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[VIEWER, okOut("usirin\n")],
	[TRUNK, okOut("main\n")],
	[CODEOWNERS, okOut("/packages/fabrika-cli/ @kamp-us/control-plane\n")],
	[MEMBERS, okOut(JSON.stringify([{login: "usirin"}, {login: "cansirin"}]))],
];

const POSTED = okOut(
	JSON.stringify({id: 512346, html_url: "https://github.com/o/r/issues/4300#c"}),
);

const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(
			runApprove({number: 4300, repo: null, env, cwd: CWD, now: NOW}),
			planContext(shell),
		),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

/** The bytes the verb handed `gh` — the `-f body=` operand is last on the POST line. */
const postedBody = (calls: ReadonlyArray<string>): string => {
	const line = calls.find((candidate) => POST.test(candidate)) ?? "";
	return /-f body=([\s\S]*)$/.exec(line)?.[1] ?? "";
};

const derivedDigest = (): Promise<string> => digestOver(ledger, {env});

describe("runApprove", () => {
	it("posts a marker bound to the digest it derived itself and reads it back", async () => {
		const digest = await derivedDigest();
		const first = await run([...ledger, ...acl, [POST, POSTED]]);
		const body = postedBody(first.calls);
		const {outcome} = await run([
			...ledger,
			...acl,
			[POST, POSTED],
			[GET_COMMENT, okOut(JSON.stringify({body}))],
		]);
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
		const {calls} = await run([...ledger, ...acl, [POST, POSTED]]);
		const marked = readApproval(postedBody(calls));
		expect(marked._tag).toBe("Found");
		if (marked._tag !== "Found") return;
		expect(marked.value).toEqual({epic: 4300, digest, at: "2026-08-16T07:16:03Z"});
	});

	it("refuses 24 when the invoking account is not on the roster, and posts nothing", async () => {
		const {outcome, calls} = await run([
			[VIEWER, okOut("someone-else\n")],
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
			[CODEOWNERS, okOut("# nobody owns anything\n")],
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
			[MEMBERS, errOut("HTTP 502")],
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
			[CODEOWNERS, errOut("HTTP 500")],
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
			[GET_COMMENT, okOut(JSON.stringify({body: "plan-approved: #4300 @ ffffffffffff · x\n"}))],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});
});
