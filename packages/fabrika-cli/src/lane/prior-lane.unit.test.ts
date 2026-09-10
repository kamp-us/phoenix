/** The board read `lane open` refuses a re-boot on — driven, fresh, and the read that failed. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeHttp, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import {priorLaneReader} from "./prior-lane.ts";

const ISSUE = 7981;
const CLOSERS = /^POST .*\/graphql$/;
const ENV = {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"} as Record<
	string,
	string | undefined
>;

const closingEdge = (...rows: ReadonlyArray<readonly [number, string]>): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		data: {
			repository: {
				issue: {
					closedByPullRequestsReferences: {
						pageInfo: {hasNextPage: false, endCursor: null},
						nodes: rows.map(([number, state]) => ({
							number,
							url: `https://forge.example/o/r/pull/${number}`,
							state,
						})),
					},
				},
			},
		},
	}),
});

const readAt = (reply: HttpReply, repo: string | null = "o/r", env = ENV) =>
	Effect.runPromise(
		Effect.provide(
			priorLaneReader(repo, env)(ISSUE),
			Layer.merge(fakeShell([]).layer, fakeHttp([[CLOSERS, reply]]).layer),
		),
	);

describe("priorLaneReader", () => {
	it("reads an open pull request off the issue as a lane that already drove it", async () => {
		expect(await readAt(closingEdge([7990, "OPEN"]))).toEqual({_tag: "Prior", pulls: [7990]});
	});

	it("reads a merged one the same way — a lane that landed still drove the issue", async () => {
		expect(await readAt(closingEdge([7990, "MERGED"]))).toEqual({_tag: "Prior", pulls: [7990]});
	});

	it("reads an issue nothing closes as Fresh — the wrong-template retire never opened a PR", async () => {
		expect(await readAt(closingEdge())).toEqual({_tag: "Fresh"});
	});

	it("answers Unknown on a failed read, never Fresh", async () => {
		const read = await readAt({status: 502, body: "bad gateway"});

		expect(read._tag).toBe("Unknown");
	});

	it("answers Unknown when no repo resolves, asking the board nothing", async () => {
		const read = await readAt(closingEdge(), null, {});

		expect(read).toEqual({
			_tag: "Unknown",
			reason: "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name",
		});
	});
});
