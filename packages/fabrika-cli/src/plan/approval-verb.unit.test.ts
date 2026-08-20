import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {comments} from "../build/fixtures.test-support.ts";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {runApproval} from "./approval-verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
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
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4300\/comments/;
const TRUNK = /^gh api repos\/o\/r --jq \.default_branch$/;
const CODEOWNERS = /contents\/\.github\/CODEOWNERS\?ref=main$/;
const MEMBERS = /^gh api --paginate orgs\/kamp-us\/teams\/control-plane\/members/;

const env = {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>;

const ledger: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[EPIC, epic({body: epicBody({dependencies: "- phase 1: #4301"})})],
	[SUBS, subIssues(4301)],
	[CHILD, child({number: 4301})],
	[CYCLE, okOut("{}")],
];

/** The same roster `plan approve` writes under — resolved again here, over the marker's author. */
const acl: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[TRUNK, okOut("main\n")],
	[CODEOWNERS, okOut("/packages/fabrika-cli/ @kamp-us/control-plane\n")],
	[MEMBERS, okOut(JSON.stringify([{login: "usirin"}, {login: "cansirin"}]))],
];

const marker = (epicRef: number, digest: string): string =>
	`plan-approved: #${epicRef} @ ${digest} · 2026-08-16T07:16:03Z\n`;

/** Earlier entries win, so a case overrides one roster read by naming it before the defaults. */
const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
	Effect.runPromise(
		Effect.provide(
			runApproval({number: 4300, repo: null, env, cwd: CWD}),
			planContext(fakeShell([...script, ...acl])),
		),
	);

const derivedDigest = (): Promise<string> => digestOver(ledger, {env});

describe("runApproval", () => {
	it("answers current with the author and both digests", async () => {
		const digest = await derivedDigest();
		const outcome = await run([
			[COMMENTS, comments({id: 91, body: marker(4300, digest), author: "usirin"})],
			...ledger,
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "approval",
			epic: 4300,
			state: "current",
			by: "usirin",
			markerDigest: digest,
			derivedDigest: digest,
			at: "2026-08-16T07:16:03Z",
			comment: 91,
			disregarded: 0,
			unauthorized: 0,
		});
	});

	it("answers stale when the plan moved after the marker landed", async () => {
		const digest = await derivedDigest();
		const outcome = await run([
			[COMMENTS, comments({id: 91, body: marker(4300, "0000000000ff"), author: "usirin"})],
			...ledger,
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			state: "stale",
			markerDigest: "0000000000ff",
			derivedDigest: digest,
		});
	});

	/** The whole point of the reporting/enforcement split: absent is an answer, not a refusal. */
	it("answers absent at exit 0 — it never refuses on a missing approval", async () => {
		const outcome = await run([
			[COMMENTS, comments({id: 91, body: "Looks reasonable to me.\n"})],
			...ledger,
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({state: "absent", by: null, comment: null});
	});

	/** Bytes travel: a marker naming another epic is a quoted comment here, not this epic's approval. */
	it("does not take a marker naming a different epic as this epic's approval", async () => {
		const digest = await derivedDigest();
		const outcome = await run([
			[COMMENTS, comments({id: 91, body: marker(4301, digest), author: "usirin"})],
			...ledger,
		]);
		expect(JSON.parse(outcome.stdout)).toMatchObject({state: "absent"});
	});

	it("counts a drifted marker as disregarded rather than folding it into absent", async () => {
		const outcome = await run([
			[COMMENTS, comments({id: 91, body: "plan-approved: #4300 @ NOTHEX · yesterday\n"})],
			...ledger,
		]);
		expect(JSON.parse(outcome.stdout)).toMatchObject({state: "absent", disregarded: 1});
	});

	it("takes the newest marker when the plan was approved twice", async () => {
		const digest = await derivedDigest();
		const outcome = await run([
			[
				COMMENTS,
				comments(
					{id: 91, body: marker(4300, "0000000000ff"), author: "usirin"},
					{id: 92, body: marker(4300, digest), author: "cansirin"},
				),
			],
			...ledger,
		]);
		expect(JSON.parse(outcome.stdout)).toMatchObject({state: "current", by: "cansirin"});
	});

	it("refuses 11 when the comment list cannot be read — UNKNOWN, not absent", async () => {
		const outcome = await run([[COMMENTS, errOut("HTTP 502")], ...ledger]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("the approval state is UNKNOWN, not absent");
	});

	/**
	 * The gate the write side alone cannot hold: posting these bytes takes only the ability to comment
	 * on the epic, and the digest is on `plan check`'s stdout (ADR 0289, ADR 0055 over 0051).
	 */
	it("does not honour a marker from an account off the control-plane roster", async () => {
		const digest = await derivedDigest();
		const outcome = await run([
			[COMMENTS, comments({id: 91, body: marker(4300, digest), author: "some-agent"})],
			...ledger,
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			state: "absent",
			by: null,
			comment: null,
			unauthorized: 1,
		});
	});

	it("falls back to the newest ON-roster marker when a later off-roster one names the epic", async () => {
		const digest = await derivedDigest();
		const outcome = await run([
			[
				COMMENTS,
				comments(
					{id: 91, body: marker(4300, digest), author: "usirin"},
					{id: 92, body: marker(4300, "0000000000ff"), author: "some-agent"},
				),
			],
			...ledger,
		]);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			state: "current",
			by: "usirin",
			comment: 91,
			unauthorized: 1,
		});
	});

	it("answers absent when CODEOWNERS names no control-plane owner — nobody may approve here", async () => {
		const digest = await derivedDigest();
		const outcome = await run([
			[CODEOWNERS, okOut("# nobody owns anything\n")],
			[COMMENTS, comments({id: 91, body: marker(4300, digest), author: "usirin"})],
			...ledger,
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({state: "absent", unauthorized: 1});
	});

	/** #4223 on the read side: an unread roster is neither an approval nor its absence. */
	it("refuses 11 when the roster read fails — never absent and never current", async () => {
		const digest = await derivedDigest();
		const outcome = await run([
			[MEMBERS, errOut("HTTP 502")],
			[COMMENTS, comments({id: 91, body: marker(4300, digest), author: "usirin"})],
			...ledger,
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain("the approval state is UNKNOWN, not absent");
	});

	it("refuses 11 when the CODEOWNERS read fails", async () => {
		const outcome = await run([[CODEOWNERS, errOut("HTTP 500")], ...ledger]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});
});
