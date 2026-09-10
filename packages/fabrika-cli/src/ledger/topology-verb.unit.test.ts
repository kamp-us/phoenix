import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GIT_DIRS, served} from "../build/fixtures.test-support.ts";
import {fakeFs, fakeSeams, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BAD_SECTIONS,
	EMPTY_STDIN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	TOPOLOGY_INVALID,
	ZERO_SCOPE,
} from "./codes.ts";
import {bodyDigest} from "./digest.ts";
import {CLAIMED, DIR, env, epic, TOKEN} from "./fixtures.test-support.ts";
import {
	type ChildRecord,
	manifestPath,
	renderManifest,
	renderRunRecord,
	runJsonPath,
	topologyPath,
} from "./run.ts";
import {runTopology} from "./topology-verb.ts";

const GROUND: ReadonlyArray<Scripted> = [
	[/^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300$/, epic()],
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
	...CLAIMED,
];

const RUN_JSON = renderRunRecord({
	epic: 4300,
	run: "4300-c1a4d6f8",
	mode: "fresh",
	cycleDoc: "present",
	bodyDigest: bodyDigest("An epic brief about the moderation queue.\n"),
});

const record = (number: number, mintedThisRun = true): ChildRecord => ({
	number,
	id: number * 10,
	title: `child ${number}`,
	type: "type:feature",
	priority: "p1",
	readyFor: "agent",
	stories: [1],
	containment: "flag",
	linked: true,
	mintedThisRun,
});

const files = (...records: ReadonlyArray<ChildRecord>) => ({
	[runJsonPath(DIR)]: RUN_JSON,
	[manifestPath(DIR)]: renderManifest(records),
});

const ISSUE = (number: number) =>
	new RegExp(`^GET https://api\\.github\\.com/repos/o/r/issues/${number}$`);

const run = (
	stdinText: string,
	fsFiles: Readonly<Record<string, string | null>> = files(record(4301), record(4303)),
	/** The external-prerequisite probes this run should meet, appended after the ground script. */
	probes: ReadonlyArray<Scripted> = [],
) => {
	const shell = fakeSeams([...GROUND, ...probes]);
	const fs = fakeFs({files: fsFiles});
	const stdin: Effect.Effect<StdinRead> = Effect.succeed({_tag: "Text", text: stdinText});
	return Effect.runPromise(
		Effect.provide(
			runTopology({number: 4300, token: TOKEN, repo: null, cwd: "/repo", env, stdin}),
			Layer.mergeAll(shell.layer, fs.layer),
		),
	).then((outcome) => ({outcome, written: fs.written, requests: shell.requests}));
};

describe("runTopology", () => {
	it("stages the rendered block and reports the edges it validated", async () => {
		const {outcome, written} = await run("#4301 phase 1\n#4303 phase 2 requires #4301\n");
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			answer: "staged",
			epic: 4300,
			document: "topology",
			phases: 2,
			children: 2,
			edges: {rows: [["#4303", "#4301"]], more: 0},
			external: 0,
		});
		expect(written.get(topologyPath(DIR))).toBe(
			"## Dependencies\n\n- phase 1: #4301\n- phase 2: #4303\n- #4303 requires: #4301\n",
		);
	});

	/**
	 * The corpus's cross-epic edge, end to end: the target is proven at the boundary, the block keeps
	 * the reference, and the machine result counts the explicit edge over it.
	 */
	it("stages an external prerequisite it proved is a real issue", async () => {
		const {outcome, written} = await run(
			"#4301 phase 1\n#4303 phase 2 requires #4301, #7511\n",
			files(record(4301), record(4303)),
			[[ISSUE(7511), served({number: 7511, id: 75110})]],
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			edges: {
				rows: [
					["#4303", "#4301"],
					["#4303", "#7511"],
				],
				more: 0,
			},
			external: 1,
		});
		expect(written.get(topologyPath(DIR))).toBe(
			"## Dependencies\n\n- phase 1: #4301\n- phase 2: #4303\n- #4303 requires: #4301, #7511\n",
		);
	});

	it("refuses 24 on an external prerequisite proven absent, staging nothing", async () => {
		const {outcome, written} = await run(
			"#4301 phase 1\n#4303 phase 2 requires #7511\n",
			files(record(4301), record(4303)),
			[[ISSUE(7511), {status: 404, body: '{"message":"Not Found"}'}]],
		);
		expect(outcome.code).toBe(TOPOLOGY_INVALID);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger topology: #7511 is named as an external prerequisite and is proven absent — no edge can point at it.",
		);
		expect(written.size).toBe(0);
	});

	/** An unread target is never read as a good one — a 502 is UNKNOWN, and UNKNOWN stages nothing. */
	it("refuses 11 on an external prerequisite it could not read", async () => {
		const {outcome, written} = await run(
			"#4301 phase 1\n#4303 phase 2 requires #7511\n",
			files(record(4301), record(4303)),
			[[ISSUE(7511), {status: 502, body: '{"message":"Bad gateway"}'}]],
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("ledger topology: cannot read #7511:");
		expect(written.size).toBe(0);
	});

	/**
	 * `repos/{o}/{r}/issues/<n>` serves pull requests too, so the 404 arm never fires for one. The
	 * corpus names a blocking pull request by the issue its merge closes, and this enforces it.
	 */
	it("refuses 24 on an external number that resolves to a pull request", async () => {
		const {outcome, written} = await run(
			"#4301 phase 1\n#4303 phase 2 requires #7511\n",
			files(record(4301), record(4303)),
			[[ISSUE(7511), served({number: 7511, id: 75110, pull_request: {url: "…"}})]],
		);
		expect(outcome.code).toBe(TOPOLOGY_INVALID);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger topology: #7511 is named as an external prerequisite and is a pull request — a blocking pull request is named by the issue its merge closes.",
		);
		expect(written.size).toBe(0);
	});

	/** No external ref, no probe: a same-epic topology reaches GitHub exactly as often as it used to. */
	it("probes nothing when every prerequisite is a manifest child", async () => {
		const {requests} = await run("#4301 phase 1\n#4303 phase 2 requires #4301\n");
		expect(requests.some((line) => ISSUE(4301).test(line))).toBe(false);
	});

	/**
	 * `edges` is an evidence array — a validated echo of the caller's own stdin — so it caps at 5
	 * pairs and counts the rest; the rendered block still carries every edge.
	 */
	it("caps the echoed edges and counts the remainder", async () => {
		const seven = [record(4301)];
		for (let number = 4302; number <= 4307; number += 1) seven.push(record(number));
		const lines = [
			"#4301 phase 1\n#4302 phase 1\n#4303 phase 1\n#4304 phase 1\n#4305 phase 1\n#4306 phase 1",
			"#4307 phase 2 requires #4301, #4302, #4303, #4304, #4305, #4306\n",
		].join("\n");
		const {outcome} = await run(lines, files(...seven));
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).edges).toEqual({
			rows: [
				["#4307", "#4301"],
				["#4307", "#4302"],
				["#4307", "#4303"],
				["#4307", "#4304"],
				["#4307", "#4305"],
			],
			more: 1,
		});
	});

	it("is order-indifferent over its lines", async () => {
		const {written: forwards} = await run("#4301 phase 1\n#4303 phase 2 requires #4301\n");
		const {written: backwards} = await run("#4303 phase 2 requires #4301\n#4301 phase 1\n");
		expect(backwards.get(topologyPath(DIR))).toBe(forwards.get(topologyPath(DIR)));
	});

	it("refuses a line off the grammar", async () => {
		const {outcome} = await run("#4301 phase 1\n4303 in phase two\n");
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(outcome.stderr.at(-1)).toBe(
			'ledger topology: line 2 does not parse: "4303 in phase two" — want "#<ref> phase <n> [requires #<a>]".',
		);
	});

	/** A phase off its closed vocabulary is a semantic refusal, never a malformed-line `4`. */
	it("refuses a phase that is not a positive integer", async () => {
		const {outcome} = await run("#4301 phase 0\n");
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe('ledger topology: phase "0" is not a positive integer.');
	});

	it("refuses a manifest child placed in no phase", async () => {
		const {outcome} = await run("#4301 phase 1\n");
		expect(outcome.code).toBe(TOPOLOGY_INVALID);
		expect(outcome.stderr.at(-1)).toBe("ledger topology: child #4303 is placed in no phase.");
	});

	it("refuses a subject that is not a child of this epic", async () => {
		const {outcome} = await run("#4301 phase 1\n#4303 phase 1\n#9999 phase 2 requires #4301\n");
		expect(outcome.code).toBe(TOPOLOGY_INVALID);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger topology: #9999 is placed in a phase but is not a child of #4300.",
		);
	});

	it("refuses a cycle", async () => {
		const {outcome} = await run("#4301 phase 1 requires #4303\n#4303 phase 1 requires #4301\n");
		expect(outcome.code).toBe(TOPOLOGY_INVALID);
		expect(outcome.stderr.at(-1)).toContain("cycle:");
	});

	/**
	 * A retained child is in the manifest because `ledger open` seeded it, and that is what makes a
	 * re-plan placeable — naming one is not a dangling ref and omitting one is not clean.
	 */
	it("places a retained child the same as one this run minted", async () => {
		const {outcome} = await run(
			"#4301 phase 1\n#4288 phase 1\n",
			files(record(4301), record(4288, false)),
		);
		expect(outcome.code).toBe(0);
	});

	/** An empty manifest is a refused scope, never a rendered empty topology. */
	it("reds on zero scope rather than rendering a topology over no children", async () => {
		const {outcome, written} = await run("#4301 phase 1\n", files());
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger topology: the run manifest holds zero children — refusing to render a topology over zero scope.",
		);
		expect(written.size).toBe(0);
	});

	it("refuses an empty pipe", async () => {
		const {outcome} = await run("\n\n");
		expect(outcome.code).toBe(EMPTY_STDIN);
	});

	it("refuses an unreadable manifest rather than reading it as no children", async () => {
		const {outcome} = await run("#4301 phase 1\n", {[runJsonPath(DIR)]: RUN_JSON});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a manifest line that does not parse", async () => {
		const {outcome} = await run("#4301 phase 1\n", {
			[runJsonPath(DIR)]: RUN_JSON,
			[manifestPath(DIR)]: "not a record\n",
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
