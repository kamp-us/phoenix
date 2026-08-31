import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {fakeSeams, type HttpReply, linkNext, once, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {forgetAmbientToken} from "../io/gh-api.ts";
import {
	INCOMPLETE_SCAN,
	NUDGE_REOPEN_UNCONFIRMED,
	PRECONDITION_UNKNOWN,
	PROVEN_NOT_IN_STATE,
	STALE_HEAD,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {checkRuns, ENV, HEAD, OTHER_HEAD, pull} from "./fixtures.test-support.ts";
import {runReviewUiRequest} from "./review-ui-request-verb.ts";

const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;
const REPO = /^GET \S+\/repos\/o\/r$/;
const AUTHORITY_COMMIT = /^GET \S+\/repos\/o\/r\/commits\/main$/;
const AUTHORITY = /contents\/\.github\/review-ui-localhost-harnesses\.json/;
const CHECKS = /commits\/[0-9a-f]+\/check-runs\?/;
const STATUSES = /commits\/[0-9a-f]+\/statuses\?/;
const RUNS = /actions\/workflows\/review-ui-localhost-evidence\.yml\/runs/;
const PATCH_PULL = /^PATCH \S+\/repos\/o\/r\/pulls\/4321$/;
const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4321\/comments/;
const CREATE_COMMENT = /POST .*\/repos\/o\/r\/issues\/4321\/comments/;
const READ_COMMENT = /GET .*\/repos\/o\/r\/issues\/comments\/99/;
const AUTHORITY_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REQUEST_MARKER = `<!-- fabrika:ship-review-ui-request head=${HEAD} authority=${AUTHORITY_HEAD} harness=tuval -->`;
const REQUEST_BODY = `${REQUEST_MARKER}\n\nOperator-owned governed review-ui evidence request.\n\n- Authority: ${AUTHORITY_HEAD}\n- Workflow: .github/workflows/review-ui-localhost-evidence.yml\n- Check: review-ui localhost evidence / tuval`;

const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});
const authority = JSON.stringify({
	schemaVersion: 1,
	harnesses: [
		{
			id: "tuval",
			workflow: ".github/workflows/review-ui-localhost-evidence.yml",
			check: "review-ui localhost evidence / tuval",
			event: "pull_request_target",
			artifact: "review-ui-localhost-tuval",
			captureCommand: ["pnpm", "--filter", "tuval", "test:browser"],
			serverBuildCommand: ["pnpm", "--filter", "tuval", "build"],
			serverCommand: ["node", "server.mjs", "4173"],
			containerPort: 4173,
			readinessPattern: "ready",
			captureReadySelector: ".react-flow__node",
			surfaces: [{id: "desktop", route: "/", state: "desktop", width: 1280, height: 800}],
		},
	],
});
const runs = (rows: readonly Record<string, unknown>[] = []): HttpReply => ({
	status: 200,
	body: JSON.stringify({total_count: rows.length, workflow_runs: rows}),
});
const exactRun = (overrides: Record<string, unknown> = {}) => ({
	id: 42,
	status: "completed",
	conclusion: "success",
	event: "pull_request_target",
	path: ".github/workflows/review-ui-localhost-evidence.yml",
	repository: {full_name: "o/r"},
	head_sha: HEAD,
	display_title: `review-ui localhost evidence / tuval / PR #4321 / subject ${HEAD} / authority ${AUTHORITY_HEAD}`,
	check_suite_id: 7,
	...overrides,
});
const statusRows = (rows: readonly Record<string, unknown>[] = [], next?: string): HttpReply => ({
	status: 200,
	body: JSON.stringify(rows),
	...(next === undefined ? {} : {headers: linkNext(next)}),
});
const comments = (rows: ReadonlyArray<{id: number; body: string}> = []): HttpReply => ({
	status: 200,
	body: JSON.stringify(
		rows.map((row) => ({
			id: row.id,
			body: row.body,
			user: {login: "operator"},
			created_at: "2026-08-08T10:00:00Z",
			updated_at: "2026-08-08T10:00:00Z",
		})),
	),
});

const options = {pr: 4321, sha: HEAD, harness: "tuval", repo: null, json: false, env: ENV};

const beforeMutation = (
	checkRows: Parameters<typeof checkRuns>[1] = [
		{name: "ordinary / lint", status: "completed", conclusion: "success"},
	],
	workflowRows: readonly Record<string, unknown>[] = [],
	finalAuthorityHead = AUTHORITY_HEAD,
	priorRequest: boolean | string = false,
	mutationHead = HEAD,
	mutationCheckRows = checkRows,
	mutationWorkflowRows = workflowRows,
): ReadonlyArray<Scripted> => [
	[once(PULL), served(pull())],
	[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
	[once(AUTHORITY_COMMIT), {status: 200, body: JSON.stringify({sha: AUTHORITY_HEAD})}],
	[AUTHORITY, {status: 200, body: authority}],
	[once(CHECKS), served(checkRuns(checkRows.length, checkRows))],
	[once(STATUSES), statusRows([{context: "ordinary/status", state: "success", sha: HEAD}])],
	[once(RUNS), runs(workflowRows)],
	[
		once(COMMENTS),
		comments(
			priorRequest
				? [{id: 88, body: typeof priorRequest === "string" ? priorRequest : REQUEST_BODY}]
				: [],
		),
	],
	[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
	[AUTHORITY_COMMIT, {status: 200, body: JSON.stringify({sha: finalAuthorityHead})}],
	[once(PULL), served(pull())],
	[
		CREATE_COMMENT,
		{status: 201, body: JSON.stringify({id: 99, html_url: "https://example.test/comment/99"})},
	],
	[READ_COMMENT, {status: 200, body: JSON.stringify({body: REQUEST_BODY})}],
	[COMMENTS, comments([{id: 99, body: REQUEST_BODY}])],
	[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
	[AUTHORITY_COMMIT, {status: 200, body: JSON.stringify({sha: finalAuthorityHead})}],
	[once(PULL), served(pull({head: mutationHead}))],
	[CHECKS, served(checkRuns(mutationCheckRows.length, mutationCheckRows))],
	[STATUSES, statusRows([{context: "ordinary/status", state: "success", sha: HEAD}])],
	[RUNS, runs(mutationWorkflowRows)],
];

const execute = async (script: ReadonlyArray<Scripted>, overrides = {}) => {
	const seams = fakeSeams(script);
	const outcome = await Effect.runPromise(
		Effect.provide(runReviewUiRequest({...options, ...overrides}), seams.layer),
	);
	return {outcome, seams};
};

beforeEach(() => {
	forgetAmbientToken();
	vi.stubEnv("GITHUB_TOKEN", "token");
});

afterEach(() => {
	vi.unstubAllEnvs();
	forgetAmbientToken();
});

describe("runReviewUiRequest", () => {
	it("ignores ordinary checks, closes, verifies, reopens, verifies, and reports exhaustive counts", async () => {
		const {outcome} = await execute([
			...beforeMutation(),
			[once(PATCH_PULL), {status: 200, body: "{}"}],
			[once(PULL), served(pull({state: "closed"}))],
			[PATCH_PULL, {status: 200, body: "{}"}],
			[PULL, served(pull())],
		]);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(`requested\t${HEAD}\ttuval\tchecks:1\tstatuses:1\truns:0\n`);
	});

	it("refuses at most once from a durable marker bound to this exact head and harness", async () => {
		const {outcome, seams} = await execute(beforeMutation(undefined, [], AUTHORITY_HEAD, true));
		expect(outcome.code).toBe(PROVEN_NOT_IN_STATE);
		expect(outcome.stderr.join("\n")).toContain("a second request is escalation, not retry");
		expect(seams.requests.some((request) => request.startsWith("PATCH"))).toBe(false);
	});

	it("allows one replacement request for a stale-authority run, check, and request marker", async () => {
		const staleAuthority = OTHER_HEAD;
		const staleRun = exactRun({
			check_suite_id: 7,
			display_title: `review-ui localhost evidence / tuval / PR #4321 / subject ${HEAD} / authority ${staleAuthority}`,
		});
		const staleMarker = `<!-- fabrika:ship-review-ui-request head=${HEAD} authority=${staleAuthority} harness=tuval -->\n\nold request`;
		const governedCheck = [
			{
				name: "review-ui localhost evidence / tuval",
				status: "completed",
				conclusion: "success",
				check_suite_id: 7,
			},
		];
		const {outcome} = await execute([
			...beforeMutation(
				governedCheck,
				[staleRun],
				AUTHORITY_HEAD,
				staleMarker,
				HEAD,
				governedCheck,
				[staleRun],
			),
			[once(PATCH_PULL), {status: 200, body: "{}"}],
			[once(PULL), served(pull({state: "closed"}))],
			[PATCH_PULL, {status: 200, body: "{}"}],
			[PULL, served(pull())],
		]);
		expect(outcome.code).toBe(0);
	});

	it("refuses a stale caller head before reading authority or writing", async () => {
		const {outcome, seams} = await execute([[PULL, served(pull({head: OTHER_HEAD}))]]);
		expect(outcome.code).toBe(STALE_HEAD);
		expect(seams.requests.some((request) => AUTHORITY.test(request))).toBe(false);
		expect(seams.requests.some((request) => request.startsWith("PATCH"))).toBe(false);
	});

	it("reopens but refuses stale when the head moves during the close/reopen event", async () => {
		const {outcome} = await execute([
			...beforeMutation(),
			[once(PATCH_PULL), {status: 200, body: "{}"}],
			[once(PULL), served(pull({state: "closed", head: OTHER_HEAD}))],
			[PATCH_PULL, {status: 200, body: "{}"}],
			[PULL, served(pull({head: OTHER_HEAD}))],
		]);
		expect(outcome.code).toBe(STALE_HEAD);
		expect(outcome.stderr.join("\n")).toContain("the reopen is confirmed");
	});

	it("refuses a governed check in pending, success, failure, or ambiguous multiplicity while allowing other checks", async () => {
		for (const rows of [
			[{name: "review-ui localhost evidence / tuval", status: "queued", conclusion: null}],
			[
				{name: "ordinary / lint", status: "completed", conclusion: "success"},
				{
					name: "review-ui localhost evidence / tuval",
					status: "completed",
					conclusion: "success",
				},
			],
			[
				{
					name: "review-ui localhost evidence / tuval",
					status: "completed",
					conclusion: "failure",
				},
			],
			[
				{name: "review-ui localhost evidence / tuval", status: "queued", conclusion: null},
				{
					name: "review-ui localhost evidence / tuval",
					status: "completed",
					conclusion: "failure",
				},
			],
		] as const) {
			const {outcome, seams} = await execute(beforeMutation([...rows]));
			expect(outcome.code).toBe(PROVEN_NOT_IN_STATE);
			expect(seams.requests.some((request) => request.startsWith("PATCH"))).toBe(false);
		}
	});

	it("refuses an incomplete check-run enumeration before mutation", async () => {
		const script = beforeMutation().map((row) =>
			row[0] === CHECKS
				? ([CHECKS, served(checkRuns(2, [{name: "ordinary", status: "completed"}]))] as Scripted)
				: row,
		);
		const {outcome, seams} = await execute(script);
		expect(outcome.code).toBe(INCOMPLETE_SCAN);
		expect(seams.requests.some((request) => request.startsWith("PATCH"))).toBe(false);
	});

	it("reads every commit-status page and refuses a governed row on the terminal page", async () => {
		const second = "https://api.github.com/repos/o/r/commits/x/statuses?per_page=100&page=2";
		const script = beforeMutation().flatMap(
			(row): ReadonlyArray<Scripted> =>
				row[0] === STATUSES
					? [
							[
								once(STATUSES),
								statusRows([{context: "ordinary", state: "success", sha: HEAD}], second),
							],
							[
								STATUSES,
								statusRows([
									{
										context: "review-ui localhost evidence / tuval",
										state: "pending",
										sha: HEAD,
									},
								]),
							],
						]
					: [row],
		);
		const {outcome} = await execute(script);
		expect(outcome.code).toBe(PROVEN_NOT_IN_STATE);
		expect(outcome.stderr.join("\n")).toContain("commit status row(s) already exist");
	});

	it("refuses a governed status even when GitHub returns an inconsistent row SHA", async () => {
		const script = beforeMutation().map((row) =>
			row[0] === STATUSES
				? ([
						STATUSES,
						statusRows([
							{
								context: "review-ui localhost evidence / tuval",
								state: "success",
								sha: OTHER_HEAD,
							},
						]),
					] as Scripted)
				: row,
		);
		const {outcome, seams} = await execute(script);
		expect(outcome.code).toBe(PROVEN_NOT_IN_STATE);
		expect(seams.requests.some((request) => request.startsWith("PATCH"))).toBe(false);
	});

	it("refuses exact or ambiguous current-head workflow runs regardless of outcome", async () => {
		for (const row of [
			exactRun({status: "queued", conclusion: null}),
			exactRun({conclusion: "failure"}),
			exactRun({display_title: "wrong current-head title"}),
		]) {
			const {outcome} = await execute(beforeMutation(undefined, [row]));
			expect(outcome.code).toBe(PROVEN_NOT_IN_STATE);
		}
	});

	it("keeps unreadable enumerations UNKNOWN and never writes", async () => {
		const {outcome, seams} = await execute([
			...beforeMutation().slice(0, 4),
			[CHECKS, {status: 503, body: "{}"}],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(seams.requests.some((request) => request.startsWith("PATCH"))).toBe(false);
	});

	it("refuses pagination that never reaches a terminal page as incomplete", async () => {
		const pages = Array.from({length: 100}, (_, index) => ({
			context: `ordinary-${index}`,
			state: "success",
			sha: HEAD,
		}));
		const script = beforeMutation().map((row) =>
			row[0] === STATUSES
				? ([STATUSES, statusRows(pages, "https://api.github.com/next")] as Scripted)
				: row,
		);
		const {outcome} = await execute(script);
		expect(outcome.code).toBe(INCOMPLETE_SCAN);
	});

	it("requires the at-most-once marker write and exact readback before PR-state mutation", async () => {
		const writeUnknown = beforeMutation().map((row) =>
			row[0] === CREATE_COMMENT ? ([CREATE_COMMENT, {status: 502, body: "{}"}] as Scripted) : row,
		);
		const failed = await execute(writeUnknown);
		expect(failed.outcome.code).toBe(WRITE_UNKNOWN);
		expect(failed.seams.requests.some((request) => request.startsWith("PATCH"))).toBe(false);

		const mismatch = beforeMutation().map((row) =>
			row[0] === READ_COMMENT
				? ([READ_COMMENT, {status: 200, body: JSON.stringify({body: "other"})}] as Scripted)
				: row,
		);
		const mismatched = await execute(mismatch);
		expect(mismatched.outcome.code).toBe(9);
		expect(mismatched.seams.requests.some((request) => request.startsWith("PATCH"))).toBe(false);
	});

	it("loses a concurrent marker race before touching PR state", async () => {
		const raced = beforeMutation().map((row) =>
			row[0] === COMMENTS
				? ([
						COMMENTS,
						comments([
							{id: 99, body: REQUEST_BODY},
							{id: 100, body: REQUEST_BODY},
						]),
					] as Scripted)
				: row,
		);
		const {outcome, seams} = await execute(raced);
		expect(outcome.code).toBe(PROVEN_NOT_IN_STATE);
		expect(seams.requests.some((request) => request.startsWith("PATCH"))).toBe(false);
	});

	it("refuses when the governed authority moves before mutation", async () => {
		const {outcome, seams} = await execute(beforeMutation(undefined, [], OTHER_HEAD));
		expect(outcome.code).toBe(PROVEN_NOT_IN_STATE);
		expect(outcome.stderr.join("\n")).toContain("governed authority moved");
		expect(seams.requests.some((request) => request.startsWith("PATCH"))).toBe(false);
	});

	it("re-runs complete targeted absence after the marker and refuses delayed evidence", async () => {
		const delayed = [
			{name: "review-ui localhost evidence / tuval", status: "queued", conclusion: null},
		];
		const {outcome, seams} = await execute(
			beforeMutation(undefined, [], AUTHORITY_HEAD, false, HEAD, delayed),
		);
		expect(outcome.code).toBe(PROVEN_NOT_IN_STATE);
		expect(seams.requests.some((request) => CREATE_COMMENT.test(request))).toBe(true);
		expect(seams.requests.some((request) => request.startsWith("PATCH"))).toBe(false);
	});

	it("refuses a head move after the marker claim before touching PR state", async () => {
		const {outcome, seams} = await execute(
			beforeMutation(undefined, [], AUTHORITY_HEAD, false, OTHER_HEAD),
		);
		expect(outcome.code).toBe(STALE_HEAD);
		expect(outcome.stderr.join("\n")).toContain("after the marker claim");
		expect(seams.requests.some((request) => request.startsWith("PATCH"))).toBe(false);
	});

	it("maps an ambiguous close write to 8 only after confirming the PR open", async () => {
		const failed = await execute([
			...beforeMutation(),
			[PATCH_PULL, {status: 502, body: "{}"}],
			[PULL, served(pull())],
		]);
		expect(failed.outcome.code).toBe(WRITE_UNKNOWN);
		expect(failed.outcome.stderr.join("\n")).toContain("confirmed open");
	});

	it("trusts readback over an ambiguous close response and completes a proven close/reopen", async () => {
		const {outcome} = await execute([
			...beforeMutation(),
			[once(PATCH_PULL), {status: 502, body: "{}"}],
			[once(PULL), served(pull({state: "closed"}))],
			[PATCH_PULL, {status: 200, body: "{}"}],
			[PULL, served(pull())],
		]);
		expect(outcome.code).toBe(0);
	});

	it("safety-reopens a non-open/non-closed readback before returning 8", async () => {
		const mismatch = await execute([
			...beforeMutation(),
			[once(PATCH_PULL), {status: 200, body: "{}"}],
			[once(PULL), served(pull({state: "merged"}))],
			[PATCH_PULL, {status: 200, body: "{}"}],
			[PULL, served(pull())],
		]);
		expect(mismatch.outcome.code).toBe(WRITE_UNKNOWN);
		expect(mismatch.outcome.stderr.join("\n")).toContain("safety reopen is confirmed");
	});

	it("retains loud exit 17 when close landed but reopen is unconfirmed", async () => {
		const {outcome} = await execute([
			...beforeMutation(),
			[once(PATCH_PULL), {status: 200, body: "{}"}],
			[once(PULL), served(pull({state: "closed"}))],
			[PATCH_PULL, {status: 502, body: "{}"}],
			[PULL, served(pull({state: "closed"}))],
		]);
		expect(outcome.code).toBe(NUDGE_REOPEN_UNCONFIRMED);
		expect(outcome.stderr.join("\n")).toContain("may be CLOSED. Reopen it by hand now.");
	});
});
