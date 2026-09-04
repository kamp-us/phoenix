/** `lane emit` — the board reads, the emit refusal seats, and the write that lands the machine. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {issuePayload, NOT_FOUND, served} from "../build/fixtures.test-support.ts";
import {fakeFs, fakeHttp, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import {readGoldenFixture} from "../golden-fixture.ts";
import {
	LANE_ABSENT,
	LANE_EXISTS,
	LANE_UNREADABLE,
	TOPOLOGY_ABSENT,
	TOPOLOGY_CYCLE,
	TOPOLOGY_FOREIGN,
} from "./codes.ts";
import {runEmit} from "./emit-verb.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

const WORKFLOW = ".fabrika/lanes/4300/workflow.json";
const LOG = ".fabrika/lanes/4300/events.jsonl";
const AT = "2026-08-21T16:30:00.000Z";

const ISSUE = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300$/;
const SUBS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300\/sub_issues\?/;

const body = (): string => readGoldenFixture(import.meta.url, "./__fixtures__/epic-4300.body.txt");
const golden = (): string =>
	readGoldenFixture(import.meta.url, "./__fixtures__/epic-4300.workflow.golden.txt");

const epic = (overrides: Record<string, unknown> = {}): HttpReply =>
	served(issuePayload({number: 4300, body: body(), ...overrides}));

const children: HttpReply = {
	status: 200,
	body: JSON.stringify([
		{number: 4301, state: "open", state_reason: null},
		{number: 4302, state: "open", state_reason: null},
		{number: 4303, state: "open", state_reason: null},
	]),
};

const OPTIONS = {
	epic: 4300,
	root: ".fabrika/lanes",
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"} as Record<
		string,
		string | undefined
	>,
};

const run = (script: ReadonlyArray<readonly [RegExp, HttpReply]> = [], fs = fakeFs({files: {}})) =>
	Effect.runPromise(
		Effect.provide(
			runEmit(OPTIONS),
			Layer.mergeAll(fs.layer, fakeShell([]).layer, fakeHttp(script).layer),
		),
	).then((out) => ({out, fs}));

describe("lane emit", () => {
	it("writes the golden machine bytes to the epic's lane dir", async () => {
		const {out, fs} = await run([
			[ISSUE, epic()],
			[SUBS, children],
		]);

		expect(out.code).toBe(0);
		expect(fs.written.get(".fabrika/lanes/4300/workflow.json")).toBe(golden());
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "emitted",
			epic: 4300,
			phases: 2,
			children: 3,
		});
	});

	it("refuses an existing lane dir with the open verb's code and writes nothing", async () => {
		const {out, fs} = await run(
			[
				[ISSUE, epic()],
				[SUBS, children],
			],
			fakeFs({files: {}, directories: [".fabrika/lanes/4300"]}),
		);

		expect(out.code).toBe(LANE_EXISTS);
		expect(fs.written.size).toBe(0);
	});

	it("refuses a lane already on disk and names both steps of the remedy", async () => {
		const {out, fs} = await run(
			[
				[ISSUE, epic()],
				[SUBS, children],
			],
			fakeFs({
				files: {
					[WORKFLOW]: coderTemplateText(),
					[LOG]: `${JSON.stringify({task: "issue", event: "ISSUE.WIP", at: AT})}\n`,
				},
				directories: [".fabrika/lanes/4300"],
			}),
		);

		expect(out.code).toBe(LANE_EXISTS);
		expect(out.stdout).toBe("");
		expect(fs.written.size).toBe(0);
		const stderr = out.stderr.join("\n");
		expect(stderr).toContain("retire .fabrika/lanes/4300");
		expect(stderr).toContain("fabrika lane emit 4300");
	});

	it("refuses a proven-absent epic on the no-target seat", async () => {
		const {out} = await run([[ISSUE, NOT_FOUND]]);
		expect(out.code).toBe(LANE_ABSENT);
	});

	it("refuses an unreadable child list as UNKNOWN — never an epic with no children", async () => {
		const {out, fs} = await run([
			[ISSUE, epic()],
			[SUBS, {status: 503, body: '{"message":"unreachable"}'}],
		]);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.size).toBe(0);
	});

	it("refuses a child entry with no readable state as UNKNOWN — never a queued default", async () => {
		const {out, fs} = await run([
			[ISSUE, epic()],
			[SUBS, {status: 200, body: JSON.stringify([{number: 4301}, {number: 4302}, {number: 4303}])}],
		]);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("#4301");
		expect(fs.written.size).toBe(0);
	});

	it("refuses an epic with no topology block, naming the absence", async () => {
		const {out} = await run([
			[ISSUE, epic({body: "## Plan\n\nno topology\n"})],
			[SUBS, children],
		]);

		expect(out.code).toBe(TOPOLOGY_ABSENT);
		expect(out.stderr.join("\n")).toContain("Dependencies");
	});

	it("refuses a topology referencing a non-child, naming the ref", async () => {
		const {out} = await run([
			[ISSUE, epic({body: "## Dependencies\n\n- phase 1: #9999\n"})],
			[SUBS, children],
		]);

		expect(out.code).toBe(TOPOLOGY_FOREIGN);
		expect(out.stderr.join("\n")).toContain("#9999");
	});

	it("refuses a cycle, naming the path", async () => {
		const cyclic =
			"## Dependencies\n\n- phase 1: #4301, #4302\n- #4301 requires: #4302\n- #4302 requires: #4301\n";
		const {out} = await run([
			[ISSUE, epic({body: cyclic})],
			[SUBS, children],
		]);

		expect(out.code).toBe(TOPOLOGY_CYCLE);
		expect(out.stderr.join("\n")).toContain("#4301");
	});

	it("keeps the emit refusal seats distinct", () => {
		expect(new Set([LANE_EXISTS, TOPOLOGY_ABSENT, TOPOLOGY_FOREIGN, TOPOLOGY_CYCLE]).size).toBe(4);
	});
});
