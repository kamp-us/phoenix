/** `build claimants` — who holds a number, answered to a caller holding no claim and no token. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {runClaimants} from "./claimants-verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	adoptMarker,
	comments,
	GATEWAY,
	GH_TOKEN_ENV,
	issue,
	LANE_TOKEN,
	LANE_UUID,
	marker,
	NOT_FOUND,
	SIBLING_UUID,
	served,
} from "./fixtures.test-support.ts";

const ISSUE = /GET .*\/repos\/o\/r\/issues\/4312$/;
const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4312\/comments/;
const PERM = (login: string) => new RegExp(`GET .*/repos/o/r/collaborators/${login}/permission`);

const WRITE = served({permission: "write"});
const READ_ONLY = served({permission: "read"});

/** No CLAUDE_CODE_SESSION_ID anywhere: the verb answers without an identity of its own. */
const ENV = {...GH_TOKEN_ENV, CLAUDE_PIPELINE_REPO: "o/r"};

const run = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(
		Effect.provide(runClaimants({number: 4312, repo: null, env: ENV}), fakeSeams(script).layer),
	);

describe("build claimants", () => {
	it("names the holder, its session and the adopt route, holding no token itself", async () => {
		const out = await run([
			[ISSUE, issue()],
			[COMMENTS, comments({id: 9001, body: marker("s-dead", LANE_UUID)})],
			[PERM("agent"), WRITE],
		]);

		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer).toMatchObject({
			answer: "held",
			number: 4312,
			holder: {
				commentId: 9001,
				token: `build:s-dead:${LANE_UUID}`,
				session: "s-dead",
				authorized: true,
			},
		});
		expect(out.stderr.join("\n")).toContain("fabrika build adopt 4312 --session s-dead");
	});

	it("lists every marker, not only the winner, and counts an unauthorized one as never a winner", async () => {
		const out = await run([
			[ISSUE, issue()],
			[
				COMMENTS,
				comments(
					{id: 9001, body: marker("s-drive-by", SIBLING_UUID), author: "outsider"},
					{id: 9002, body: marker("s-9f2e", LANE_UUID), author: "agent"},
				),
			],
			[PERM("outsider"), READ_ONLY],
			[PERM("agent"), WRITE],
		]);

		const answer = JSON.parse(out.stdout);
		expect(answer.claimants.map((row: {commentId: number}) => row.commentId)).toEqual([9001, 9002]);
		expect(answer.holder.token).toBe(LANE_TOKEN);
		expect(out.stderr.join("\n")).toContain("counted, never a winner");
	});

	it("says a succession is already recorded rather than pointing at a second adopt", async () => {
		const out = await run([
			[ISSUE, issue()],
			[
				COMMENTS,
				comments(
					{id: 9001, body: marker("s-dead", LANE_UUID)},
					{id: 9002, body: adoptMarker("s-dead", "s-live", SIBLING_UUID)},
				),
			],
			[PERM("agent"), WRITE],
		]);

		expect(JSON.parse(out.stdout).adopts).toHaveLength(1);
		expect(out.stderr.join("\n")).toContain("has already been adopted");
	});

	it("answers unclaimed on a thread carrying no authorized marker", async () => {
		const out = await run([
			[ISSUE, issue()],
			[COMMENTS, comments({id: 9001, body: "ordinary discussion"})],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "unclaimed", holder: null});
	});

	it("answers a CLOSED issue rather than refusing it — a marker outliving its issue is the point", async () => {
		const out = await run([
			[ISSUE, issue({state: "closed"})],
			[COMMENTS, comments({id: 9001, body: marker("s-dead", LANE_UUID)})],
			[PERM("agent"), WRITE],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("held");
		expect(out.stderr.join("\n")).toContain("#4312 is closed");
	});

	it("refuses an absent issue on 7 — there is no thread to read", async () => {
		const out = await run([[ISSUE, NOT_FOUND]]);

		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
	});

	it("is UNKNOWN, never unclaimed, when the comments cannot be read", async () => {
		const out = await run([
			[ISSUE, issue()],
			[COMMENTS, GATEWAY],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain('UNKNOWN, never "unclaimed"');
	});

	it("is UNKNOWN, never a demotion, when an author's permission cannot be read", async () => {
		const out = await run([
			[ISSUE, issue()],
			[COMMENTS, comments({id: 9001, body: marker("s-dead", LANE_UUID)})],
			[PERM("agent"), GATEWAY],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});
});
