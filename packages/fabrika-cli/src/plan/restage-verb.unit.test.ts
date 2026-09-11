import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {comments, LANE_UUID, marker, LANE_TOKEN as TOKEN} from "../build/fixtures.test-support.ts";
import {type HttpReply, once} from "../fakes.test-support.ts";
import {
	BAD_SECTIONS,
	CLAIM_NOT_MINE,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	REGION_UNRESOLVABLE,
	TOPOLOGY_EMPTIED,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	epic,
	epicBody,
	planSeams,
	type Scripted,
	SESSION,
	SUB_ISSUES,
} from "./fixtures.test-support.ts";
import {runRestage} from "./restage-verb.ts";

const EPIC = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300$/;
const SUBS = SUB_ISSUES;
const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/4300\/comments\?/;
const PERM = /^GET .*\/repos\/o\/r\/collaborators\/agent\/permission/;
const PATCH = /^PATCH .*\/repos\/o\/r\/issues\/4300$/;
const ANY_WRITE = /^(PATCH|POST|DELETE) /;

/** The notes channel is a line array; a test asserting a phrase reads the joined text. */
const stderr = (out: {readonly stderr: ReadonlyArray<string>}): string => out.stderr.join("\n");
const SERVED: HttpReply = {status: 200, body: "{}"};
const BAD_GATEWAY: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};

const env = {
	CLAUDE_PIPELINE_REPO: "o/r",
	CLAUDE_CODE_SESSION_ID: SESSION,
	GITHUB_TOKEN: "ghp_scripted",
} as Record<string, string | undefined>;

const options = {number: 4300, token: TOKEN, repo: null, env};

const run = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(Effect.provide(runRestage(options), planSeams(script).layer));

/** This lane's claim on the epic — every mutation the group makes is gated on it. */
const CLAIMED: ReadonlyArray<Scripted> = [
	[COMMENTS, comments({id: 1, body: marker(SESSION, LANE_UUID)})],
	[PERM, {status: 200, body: '{"permission":"write"}'}],
];

const TOPOLOGY = "- phase 1: #4301\n- phase 2: #4302\n- #4302 requires: #4301";

const epicWith = (dependencies = TOPOLOGY): HttpReply => epic({body: epicBody({dependencies})});

/** The sub-issue link list, each child carrying the close facts the reconcile is derived from. */
const links = (
	...rows: ReadonlyArray<{number: number; state?: string; stateReason?: string | null}>
): HttpReply => ({
	status: 200,
	body: JSON.stringify(
		rows.map((row) => ({
			number: row.number,
			title: `child ${row.number}`,
			state: row.state ?? "open",
			state_reason: row.stateReason ?? null,
		})),
	),
});

const LIVE = links({number: 4301}, {number: 4302});
const ABANDONED = links({number: 4301}, {number: 4302, state: "closed", stateReason: "duplicate"});

describe("runRestage", () => {
	it("drops an abandoned child, proves the write, and names what moved", async () => {
		const restaged = epicBody({dependencies: "- phase 1: #4301"});
		const out = await run([
			[once(EPIC), epicWith()],
			...CLAIMED,
			[SUBS, ABANDONED],
			[PATCH, SERVED],
			[EPIC, epic({body: restaged})],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "restaged",
			epic: 4300,
			dropped: [4302],
			kept: [4301],
			written: true,
			verified: true,
		});
	});

	it("answers unchanged and issues no PATCH over a consistent topology", async () => {
		const seams = planSeams([[EPIC, epicWith()], ...CLAIMED, [SUBS, LIVE]]);
		const out = await Effect.runPromise(Effect.provide(runRestage(options), seams.layer));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "unchanged",
			epic: 4300,
			dropped: [],
			kept: [4301, 4302],
			written: false,
		});
		expect(seams.http.calls.some((call) => ANY_WRITE.test(call))).toBe(false);
	});

	it("keeps a child closed as completed — its region boots landed, not frozen", async () => {
		const out = await run([
			[EPIC, epicWith()],
			...CLAIMED,
			[SUBS, links({number: 4301, state: "closed", stateReason: "completed"}, {number: 4302})],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("unchanged");
	});

	it("refuses on 7 when the body carries no ## Dependencies region at all", async () => {
		const out = await run([
			[EPIC, epic({body: "An epic nobody planned.\n"})],
			...CLAIMED,
			[SUBS, ABANDONED],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(stderr(out)).toContain("carries no `## Dependencies` region");
	});

	it("refuses on 26 when two headings leave the region with no single meaning", async () => {
		const twice = `${epicBody({dependencies: "- phase 1: #4301"})}\n## Dependencies\n\n- phase 1: #4302\n`;
		const out = await run([[EPIC, epic({body: twice})], ...CLAIMED, [SUBS, ABANDONED]]);
		expect(out.code).toBe(REGION_UNRESOLVABLE);
		expect(stderr(out)).toContain("no single meaning");
	});

	it("refuses on 27 rather than writing a topology with no phase left", async () => {
		const out = await run([
			[EPIC, epicWith("- phase 1: #4301, #4302")],
			...CLAIMED,
			[
				SUBS,
				links(
					{number: 4301, state: "closed", stateReason: "duplicate"},
					{number: 4302, state: "closed", stateReason: "not_planned"},
				),
			],
		]);
		expect(out.code).toBe(TOPOLOGY_EMPTIED);
		expect(stderr(out)).toContain("re-plan the epic instead");
	});

	it("refuses on 4 over an unparseable block, writing nothing", async () => {
		const out = await run([[EPIC, epicWith("- phase one: #4301")], ...CLAIMED, [SUBS, ABANDONED]]);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(stderr(out)).toContain("nothing was written");
	});

	it("refuses on 7 over zero sub-issue children", async () => {
		const out = await run([[EPIC, epicWith()], ...CLAIMED, [SUBS, links()]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(stderr(out)).toContain("zero sub-issue children");
	});

	it("refuses on 15 when another lane holds the claim", async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				runRestage({...options, token: `build:${SESSION}:00000000-0000-4000-8000-000000000000`}),
				planSeams([[EPIC, epicWith()], ...CLAIMED]).layer,
			),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
	});

	it("is UNKNOWN, never a clean answer, when the sub-issue list cannot be read", async () => {
		const out = await run([[EPIC, epicWith()], ...CLAIMED, [SUBS, BAD_GATEWAY]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(stderr(out)).toContain("nothing was written");
	});

	it("calls a PATCH it cannot confirm UNKNOWN rather than written", async () => {
		const out = await run([
			[EPIC, epicWith()],
			...CLAIMED,
			[SUBS, ABANDONED],
			[PATCH, BAD_GATEWAY],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
	});

	it("reds when the body does not read back as composed", async () => {
		const out = await run([[EPIC, epicWith()], ...CLAIMED, [SUBS, ABANDONED], [PATCH, SERVED]]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(stderr(out)).toContain("needs a human eye");
	});
});
