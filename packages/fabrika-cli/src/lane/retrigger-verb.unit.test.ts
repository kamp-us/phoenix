/**
 * `lane retrigger` — the staleness read that makes it a no-op, the one write it makes, and the
 * seats the three ways a child ends unretriggered take.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {pullPayload, served} from "../build/fixtures.test-support.ts";
import {fakeHttp, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE, MERGE_CONFLICT} from "./codes.ts";
import {runRetrigger} from "./retrigger-verb.ts";

const ENV = {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"} as Record<
	string,
	string | undefined
>;

const EPIC = 8716;
const BEFORE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AFTER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SIBLING = "cccccccccccccccccccccccccccccccccccccccc";

const LIST = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/pulls\?state=open&base=epic%2F8716/;
const COMPARE = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/compare\/epic\/8716\.\.\./;
const COMPARE_FIRST = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/compare\/epic\/8716\.\.\.aaaa/;
const COMPARE_SIBLING =
	/^GET https:\/\/api\.github\.com\/repos\/o\/r\/compare\/epic\/8716\.\.\.cccc/;
const UPDATE = /^PUT https:\/\/api\.github\.com\/repos\/o\/r\/pulls\/8859\/update-branch$/;
const PULL = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/pulls\/8859$/;

const child = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	number: 8859,
	head: {sha: BEFORE, ref: "build/8766-commands-cannot-emit-76b00cfe"},
	...overrides,
});

const listed = (rows: ReadonlyArray<Record<string, unknown>>): HttpReply => served(rows);

const standing = (status: string, behindBy: number): HttpReply =>
	served({status, behind_by: behindBy, ahead_by: 1});

const ACCEPTED: HttpReply = {status: 202, body: '{"message":"Updating pull request branch."}'};

const run = (script: ReadonlyArray<readonly [RegExp, HttpReply]>) =>
	Effect.runPromise(
		Effect.provide(
			runRetrigger({epic: EPIC, repo: null, env: ENV, windowSeconds: 0}),
			Layer.mergeAll(fakeShell([]).layer, fakeHttp(script).layer),
		),
	);

const withRequests = (script: ReadonlyArray<readonly [RegExp, HttpReply]>) => {
	const http = fakeHttp(script);
	return Effect.runPromise(
		Effect.provide(
			runRetrigger({epic: EPIC, repo: null, env: ENV, windowSeconds: 0}),
			Layer.mergeAll(fakeShell([]).layer, http.layer),
		),
	).then((outcome) => ({outcome, requests: http.calls, bodies: http.bodies}));
};

describe("lane retrigger", () => {
	it("answers NONE when no open pull request sits on the assembly branch", async () => {
		const out = await run([[LIST, listed([])]]);

		expect(out.code).toBe(0);
		expect(out.stdout).toBe("RETRIGGER-VERDICT: NONE\n");
	});

	it("writes nothing to a child whose head already carries the base", async () => {
		const {outcome, requests} = await withRequests([
			[LIST, listed([child()])],
			[COMPARE, standing("ahead", 0)],
		]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("#8859 current\nRETRIGGER-VERDICT: CURRENT\n");
		expect(requests.some((line) => line.startsWith("PUT"))).toBe(false);
	});

	it("reads the base as it stands, not the pull request's frozen base sha", async () => {
		const {requests} = await withRequests([
			[LIST, listed([child()])],
			[COMPARE, standing("identical", 0)],
		]);

		expect(requests).toContain(
			`GET https://api.github.com/repos/o/r/compare/epic/8716...${BEFORE}?per_page=1`,
		);
	});

	it("updates a behind child through the branch-update endpoint, guarded by its head", async () => {
		const {outcome, requests, bodies} = await withRequests([
			[LIST, listed([child()])],
			[COMPARE, standing("behind", 3)],
			[UPDATE, ACCEPTED],
			[PULL, served(pullPayload({number: 8859, head: {sha: AFTER, ref: "build/8766"}}))],
		]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(
			"#8859 3 behind, aaaaaaaa -> bbbbbbbb\nRETRIGGER-VERDICT: RETRIGGERED\n",
		);
		const update = requests.findIndex((line) => line.startsWith("PUT"));
		expect(update).toBeGreaterThan(-1);
		expect(JSON.parse(bodies[update] ?? "{}")).toEqual({expected_head_sha: BEFORE});
	});

	it("updates a diverged child too — it also lacks commits the base holds", async () => {
		const out = await run([
			[LIST, listed([child()])],
			[COMPARE, standing("diverged", 2)],
			[UPDATE, ACCEPTED],
			[PULL, served(pullPayload({number: 8859, head: {sha: AFTER, ref: "build/8766"}}))],
		]);

		expect(out.code).toBe(0);
		expect(out.stdout).toContain("RETRIGGER-VERDICT: RETRIGGERED");
	});

	it("is UNKNOWN, never retriggered, when an accepted update leaves the head where it was", async () => {
		const out = await run([
			[LIST, listed([child()])],
			[COMPARE, standing("behind", 1)],
			[UPDATE, ACCEPTED],
			[PULL, served(pullPayload({number: 8859, head: {sha: BEFORE, ref: "build/8766"}}))],
		]);

		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join(" ")).toContain("#8859");
	});

	it("refuses a child the assembly branch does not merge into, naming GitHub's own reason", async () => {
		const out = await run([
			[LIST, listed([child()])],
			[COMPARE, standing("behind", 1)],
			[UPDATE, {status: 422, body: '{"message":"merge conflict between base and head"}'}],
			[PULL, served(pullPayload({number: 8859, head: {sha: BEFORE, ref: "build/8766"}}))],
		]);

		expect(out.code).toBe(MERGE_CONFLICT);
		expect(out.stderr.join(" ")).toContain("merge conflict between base and head");
	});

	it("reads a declined update whose head has moved as the move it was going to buy", async () => {
		const out = await run([
			[LIST, listed([child()])],
			[COMPARE, standing("behind", 1)],
			[UPDATE, {status: 422, body: '{"message":"Validation Failed"}'}],
			[PULL, served(pullPayload({number: 8859, head: {sha: AFTER, ref: "build/8766"}}))],
		]);

		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			"#8859 1 behind, aaaaaaaa -> bbbbbbbb\nRETRIGGER-VERDICT: RETRIGGERED\n",
		);
	});

	it("routes a read that fails after an earlier child was moved to the written-to code", async () => {
		const out = await run([
			[LIST, listed([child(), child({number: 8860, head: {sha: SIBLING, ref: "build/8767"}})])],
			[COMPARE_FIRST, standing("behind", 2)],
			[UPDATE, ACCEPTED],
			[PULL, served(pullPayload({number: 8859, head: {sha: AFTER, ref: "build/8766"}}))],
			[COMPARE_SIBLING, {status: 502, body: '{"message":"Bad gateway"}'}],
		]);

		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.code).not.toBe(LANE_UNREADABLE);
		expect(out.stderr.join(" ")).toContain("#8859 2 behind, aaaaaaaa -> bbbbbbbb");
	});

	it("is UNKNOWN, never an empty sweep, when the pull request list cannot be read", async () => {
		const out = await run([[LIST, {status: 500, body: '{"message":"boom"}'}]]);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
	});

	it("writes nothing when the staleness comparison cannot be read", async () => {
		const {outcome, requests} = await withRequests([
			[LIST, listed([child()])],
			[COMPARE, {status: 502, body: '{"message":"Bad gateway"}'}],
		]);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(requests.some((line) => line.startsWith("PUT"))).toBe(false);
	});
});
