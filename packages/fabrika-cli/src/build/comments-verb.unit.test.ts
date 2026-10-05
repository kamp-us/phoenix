import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {rulingComment, rulingIssue, rulingRepo, rulingUrl} from "../wire/decision-ruling.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runComments} from "./comments-verb.ts";
import {comments, GATEWAY, issue, NOT_FOUND} from "./fixtures.test-support.ts";

const ISSUE = /^GET \S+\/repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4312\/comments/;

const options = {
	number: 4312,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = async (script: ReadonlyArray<Scripted>) => {
	const seams = fakeSeams(script);
	const out = await Effect.runPromise(Effect.provide(runComments(options), seams.layer));
	return {...out, requests: seams.requests};
};

describe("runComments", () => {
	it("prints every comment oldest first with its id, author, stamps, citation URL and body", async () => {
		const out = await run([
			[ISSUE, issue()],
			[
				COMMENTS,
				comments(
					{id: 11, body: "first", author: "alice", createdAt: "2026-08-01T00:00:00Z"},
					{id: 12, body: "**Ruled:** build it", author: "bob", createdAt: "2026-08-02T00:00:00Z"},
				),
			],
		]);
		expect(out.code).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.number).toBe(4312);
		expect(parsed.comments).toEqual([
			{
				id: 11,
				author: "alice",
				createdAt: "2026-08-01T00:00:00Z",
				updatedAt: "",
				url: expect.any(String),
				body: "first",
			},
			{
				id: 12,
				author: "bob",
				createdAt: "2026-08-02T00:00:00Z",
				updatedAt: "",
				url: expect.any(String),
				body: "**Ruled:** build it",
			},
		]);
	});

	/** The URL is only worth printing if a lane can hand it straight to `--cites`. */
	it("prints each comment's own link in the citation grammar `--cites` takes", async () => {
		const out = await run([
			[ISSUE, issue()],
			[COMMENTS, comments({id: 11, body: "first"}, {id: 12, body: "second"})],
		]);
		const urls: ReadonlyArray<string> = JSON.parse(out.stdout).comments.map(
			(c: {url: string}) => c.url,
		);
		const cited = urls.map((url) => rulingUrl(url));
		expect(cited.every((url) => url !== null)).toBe(true);
		expect(
			cited.map((url) => url && [rulingRepo(url), rulingIssue(url), rulingComment(url)]),
		).toEqual([
			["o/r", 4312, 11],
			["o/r", 4312, 12],
		]);
	});

	it("only reads — every request it makes is a GET", async () => {
		const out = await run([
			[ISSUE, issue()],
			[COMMENTS, comments({id: 11, body: "first"})],
		]);
		expect(out.requests.length).toBeGreaterThan(0);
		expect(out.requests.every((line) => line.startsWith("GET "))).toBe(true);
	});

	/** A ruling is often cited from the issue its own transcription closed. */
	it("serves a closed issue's thread on exit 0", async () => {
		const out = await run([
			[ISSUE, issue({state: "closed"})],
			[COMMENTS, comments({id: 11, body: "ruled"})],
		]);
		expect(out.code).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.state).toBe("closed");
		expect(parsed.comments.map((c: {id: number}) => c.id)).toEqual([11]);
	});

	/**
	 * An empty thread is a proven answer and a failed read is not, so the two must never print the
	 * same thing: a lane that read `[]` off a failed read would conclude nobody ruled.
	 */
	it("answers an empty thread with [] on 0, and a failed read with nothing on 11", async () => {
		const empty = await run([
			[ISSUE, issue()],
			[COMMENTS, comments()],
		]);
		expect(empty.code).toBe(0);
		expect(JSON.parse(empty.stdout).comments).toEqual([]);

		const failed = await run([
			[ISSUE, issue()],
			[COMMENTS, GATEWAY],
		]);
		expect(failed.code).toBe(PRECONDITION_UNKNOWN);
		expect(failed.stdout).toBe("");
		expect(failed.stderr.at(-1)).toContain("its comment thread is UNKNOWN");
	});

	it("refuses a proven-absent issue on 7 and prints no comment", async () => {
		const out = await run([[ISSUE, NOT_FOUND]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe("build comments: issue #4312 is proven absent.");
	});

	it("refuses an unreadable issue on 11 — the thread is UNKNOWN", async () => {
		const out = await run([[ISSUE, GATEWAY]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("its comment thread is UNKNOWN");
	});
});
