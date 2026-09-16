/** `build claims stale` — which build claims have stood on the board unmoved, and nothing cleared. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	adoptMarker,
	comments,
	GATEWAY,
	GH_TOKEN_ENV,
	LANE_UUID,
	marker,
	SIBLING_UUID,
	served,
} from "./fixtures.test-support.ts";
import {DEFAULT_OLDER_THAN_MINUTES, runStaleClaims} from "./stale-claims-verb.ts";

const SEARCH = /GET .*search\/issues/;
const COMMENTS = (issue: number) => new RegExp(`GET .*/repos/o/r/issues/${issue}/comments`);
const PERM = (login: string) => new RegExp(`GET .*/repos/o/r/collaborators/${login}/permission`);

const WRITE = served({permission: "write"});
const READ_ONLY = served({permission: "read"});

/** No session id anywhere: this verb holds no claim and needs no identity to ask. */
const ENV = {...GH_TOKEN_ENV, CLAUDE_PIPELINE_REPO: "o/r"};

const NOW = "2026-09-01T00:00:00Z";
/** Two days before {@link NOW} — past the default horizon of a day. */
const TWO_DAYS_OLD = "2026-08-30T00:00:00Z";
/** Two hours before {@link NOW} — inside the default horizon, past an explicit 60-minute one. */
const TWO_HOURS_OLD = "2026-08-31T22:00:00Z";

const candidates = (...numbers: ReadonlyArray<number>) =>
	served({
		total_count: numbers.length,
		items: numbers.map((number) => ({number, title: `issue ${String(number)}`})),
	});

const run = (script: ReadonlyArray<Scripted>, olderThanMinutes = DEFAULT_OLDER_THAN_MINUTES) =>
	Effect.runPromise(
		Effect.provide(
			runStaleClaims({olderThanMinutes, repo: null, now: NOW, env: ENV}),
			fakeSeams(script).layer,
		),
	);

describe("build claims stale", () => {
	it("rows the marker past the default horizon and leaves the one inside it alone", async () => {
		const out = await run([
			[SEARCH, candidates(4312, 4313)],
			[
				COMMENTS(4312),
				comments({id: 9001, body: marker("s-dead", LANE_UUID), createdAt: TWO_DAYS_OLD}),
			],
			[
				COMMENTS(4313),
				comments({id: 9002, body: marker("s-live", SIBLING_UUID), createdAt: TWO_HOURS_OLD}),
			],
			[PERM("agent"), WRITE],
		]);

		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.answer).toBe("stranded");
		expect(answer.scanned).toEqual({candidates: 2, markers: 2, olderThanMinutes: 1440});
		expect(answer.stranded).toHaveLength(1);
		expect(answer.stranded[0]).toMatchObject({
			issue: 4312,
			commentId: 9001,
			session: "s-dead",
			ageMinutes: 2880,
			holder: true,
			adopted: false,
		});
	});

	it("rows the same two-hour marker once an explicit horizon reaches it", async () => {
		const out = await run(
			[
				[SEARCH, candidates(4313)],
				[
					COMMENTS(4313),
					comments({id: 9002, body: marker("s-live", SIBLING_UUID), createdAt: TWO_HOURS_OLD}),
				],
				[PERM("agent"), WRITE],
			],
			60,
		);

		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.scanned.olderThanMinutes).toBe(60);
		expect(answer.stranded).toHaveLength(1);
		expect(answer.stranded[0]).toMatchObject({issue: 4313, ageMinutes: 120});
	});

	it("answers none rather than an empty list when every marker is inside the horizon", async () => {
		const out = await run([
			[SEARCH, candidates(4313)],
			[
				COMMENTS(4313),
				comments({id: 9002, body: marker("s-live", SIBLING_UUID), createdAt: TWO_HOURS_OLD}),
			],
			[PERM("agent"), WRITE],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "none", stranded: []});
		expect(out.stderr.join("\n")).toContain("has stood unmoved for 1440 minute(s)");
	});

	it("counts an index hit whose thread carries no marker, and rows nothing for it", async () => {
		const out = await run([
			[SEARCH, candidates(4312)],
			[COMMENTS(4312), comments({id: 9001, body: "we should sweep stale build-claim markers"})],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "none",
			scanned: {candidates: 1, markers: 0},
		});
	});

	it("never rows an unauthorized marker — it wins no race, so it strands nothing", async () => {
		const out = await run([
			[SEARCH, candidates(4312)],
			[
				COMMENTS(4312),
				comments({
					id: 9001,
					body: marker("s-dead", LANE_UUID),
					author: "drive-by",
					createdAt: TWO_DAYS_OLD,
				}),
			],
			[PERM("drive-by"), READ_ONLY],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "none",
			scanned: {candidates: 1, markers: 0},
		});
	});

	it("rows a raced lane's whole marker stack, flagging which one ownership resolves against", async () => {
		const out = await run([
			[SEARCH, candidates(4312)],
			[
				COMMENTS(4312),
				comments(
					{id: 9001, body: marker("s-dead", LANE_UUID), createdAt: TWO_DAYS_OLD},
					{id: 9002, body: marker("s-dead", SIBLING_UUID), createdAt: TWO_DAYS_OLD},
				),
			],
			[PERM("agent"), WRITE],
		]);

		expect(out.code).toBe(0);
		const {stranded} = JSON.parse(out.stdout);
		expect(
			stranded.map((row: {commentId: number; holder: boolean}) => [row.commentId, row.holder]),
		).toEqual([
			[9001, true],
			[9002, false],
		]);
	});

	it("flags a session an authorized adopt already names, and says the succession is under way", async () => {
		const out = await run([
			[SEARCH, candidates(4312)],
			[
				COMMENTS(4312),
				comments(
					{id: 9001, body: marker("s-dead", LANE_UUID), createdAt: TWO_DAYS_OLD},
					{id: 9003, body: adoptMarker("s-dead", "s-next", SIBLING_UUID), createdAt: NOW},
				),
			],
			[PERM("agent"), WRITE],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).stranded[0]).toMatchObject({session: "s-dead", adopted: true});
		expect(out.stderr.join("\n")).toContain("already adopted");
	});

	it("names the written succession beside a row nothing has adopted", async () => {
		const out = await run([
			[SEARCH, candidates(4312)],
			[
				COMMENTS(4312),
				comments({id: 9001, body: marker("s-dead", LANE_UUID), createdAt: TWO_DAYS_OLD}),
			],
			[PERM("agent"), WRITE],
		]);

		const stderr = out.stderr.join("\n");
		expect(stderr).toContain("fabrika build adopt <n> --session");
		expect(stderr).toContain("fabrika build release <n> --token");
		expect(stderr).toContain("Nothing clears a claim on its own.");
	});

	it("refuses UNKNOWN when the index cannot be read, never an empty stranded set", async () => {
		const out = await run([[SEARCH, GATEWAY]]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("UNKNOWN, never a short list");
	});

	it("refuses UNKNOWN when one candidate's thread cannot be read, never a short list", async () => {
		const out = await run([
			[SEARCH, candidates(4312, 4313)],
			[
				COMMENTS(4312),
				comments({id: 9001, body: marker("s-dead", LANE_UUID), createdAt: TWO_DAYS_OLD}),
			],
			[PERM("agent"), WRITE],
			[COMMENTS(4313), GATEWAY],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("cannot read the claim markers on #4313");
	});

	it("refuses UNKNOWN on a marker whose posted instant does not parse", async () => {
		const out = await run([
			[SEARCH, candidates(4312)],
			[
				COMMENTS(4312),
				comments({id: 9001, body: marker("s-dead", LANE_UUID), createdAt: "not-an-instant"}),
			],
			[PERM("agent"), WRITE],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("its age is UNKNOWN, never inside the horizon");
	});

	it("refuses a negative horizon before it reads anything", async () => {
		const out = await run([], -1);

		expect(out.code).toBe(1);
		expect(out.stderr.join("\n")).toContain("non-negative whole number of minutes");
	});
});
