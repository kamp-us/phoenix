import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GIT_DIRS, served} from "../build/fixtures.test-support.ts";
import {fakeFs, fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import {
	BAD_SECTIONS,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	TOPOLOGY_INVALID,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {runEdges} from "./edges-verb.ts";
import {CLAIMED, env, epic, TOKEN} from "./fixtures.test-support.ts";

const EPIC_READ = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300$/;
const GRAPH = (issue: number) =>
	new RegExp(`^GET https://api\\.github\\.com/repos/o/r/issues/${issue}/dependencies/blocked_by`);
const WRITE = (issue: number) =>
	new RegExp(`^POST https://api\\.github\\.com/repos/o/r/issues/${issue}/dependencies/blocked_by$`);
const ISSUE = (number: number) =>
	new RegExp(`^GET https://api\\.github\\.com/repos/o/r/issues/${number}$`);

/** Epic #6595's shape: #4302 sits in phase 2 behind #4301, and the graph carries nothing. */
const GATED = epic({
	body: "## Dependencies\n\n- phase 1: #4301\n- phase 2: #4302\n- #4302 requires: #4301\n",
});

const blockers = (...numbers: ReadonlyArray<number>): HttpReply =>
	served(numbers.map((number) => ({number, state: "open", title: `blocker ${number}`})));

const run = (script: ReadonlyArray<Scripted>) => {
	const shell = fakeSeams(script);
	const fs = fakeFs({files: {}});
	return Effect.runPromise(
		Effect.provide(
			runEdges({number: 4300, token: TOKEN, repo: null, cwd: "/repo", env}),
			Layer.mergeAll(shell.layer, fs.layer),
		),
	).then((outcome) => ({outcome, requests: shell.requests, bodies: shell.bodies}));
};

const ground = (body: HttpReply = GATED): ReadonlyArray<Scripted> => [
	[EPIC_READ, body],
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
	...CLAIMED,
];

describe("runEdges", () => {
	it("writes the missing edge on the prerequisite's internal id and proves it", async () => {
		const {outcome, bodies, requests} = await run([
			...ground(),
			[once(GRAPH(4302)), blockers()],
			[ISSUE(4301), served({number: 4301, id: 43010})],
			[WRITE(4302), served({}, 201)],
			[GRAPH(4302), blockers(4301)],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "reconciled",
			epic: 4300,
			required: 1,
			already: 0,
			written: 1,
			verified: true,
		});
		const at = requests.findIndex((line) => WRITE(4302).test(line));
		expect(JSON.parse(bodies[at] ?? "null")).toEqual({issue_id: 43010});
	});

	it("is idempotent — an edge already on the graph is `already` and is not re-POSTed", async () => {
		const {outcome, requests} = await run([...ground(), [GRAPH(4302), blockers(4301)]]);
		expect(JSON.parse(outcome.stdout)).toMatchObject({required: 1, already: 1, written: 0});
		expect(requests.some((line) => WRITE(4302).test(line))).toBe(false);
	});

	/**
	 * A `blocked_by` list may carry edges no ledger authored. Deleting one because this block does not
	 * name it would unblock work on the strength of a document that was never the carrier (ADR 0301).
	 */
	it("leaves an edge the block does not name alone", async () => {
		const {outcome, requests} = await run([...ground(), [GRAPH(4302), blockers(4301, 9999)]]);
		expect(JSON.parse(outcome.stdout)).toMatchObject({written: 0});
		expect(requests.some((line) => /DELETE/.test(line))).toBe(false);
	});

	it("refuses 11 on an unread graph, before anything is written", async () => {
		const {outcome, requests} = await run([
			...ground(),
			[GRAPH(4302), {status: 502, body: '{"message":"Bad gateway"}'}],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("nothing was written");
		expect(requests.some((line) => WRITE(4302).test(line))).toBe(false);
	});

	/** A refused POST and a POST whose response was lost look identical here; only the graph tells. */
	it("refuses 9 when a written edge does not read back", async () => {
		const {outcome} = await run([
			...ground(),
			[ISSUE(4301), served({number: 4301, id: 43010})],
			[WRITE(4302), served({}, 201)],
			[GRAPH(4302), blockers()],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stderr).toContain("ledger edges: #4302 → #4301.");
	});

	it("refuses 8 when the re-read cannot confirm the POSTs", async () => {
		const {outcome} = await run([
			...ground(),
			[once(GRAPH(4302)), blockers()],
			[ISSUE(4301), served({number: 4301, id: 43010})],
			[WRITE(4302), served({}, 201)],
			[GRAPH(4302), {status: 502, body: '{"message":"Bad gateway"}'}],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("cannot be confirmed");
	});

	it("refuses 24 on a prerequisite proven absent — no edge can point at it", async () => {
		const {outcome} = await run([
			...ground(),
			[GRAPH(4302), blockers()],
			[ISSUE(4301), {status: 404, body: '{"message":"Not Found"}'}],
		]);
		expect(outcome.code).toBe(TOPOLOGY_INVALID);
		expect(outcome.stderr.at(-1)).toContain("is proven absent");
	});

	it("refuses zero scope rather than answering over an epic that declares no topology", async () => {
		const {outcome} = await run(ground(epic({body: "An epic with no plan yet.\n"})));
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("refuses an unparseable block on 4 — 'no parseable edges' is never 'no edges'", async () => {
		const {outcome} = await run(
			ground(epic({body: "## Dependencies\n\n- phase 1: #4301\n- these two are related\n"})),
		);
		expect(outcome.code).toBe(BAD_SECTIONS);
	});
});
