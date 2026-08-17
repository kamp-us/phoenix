/** `lane emit` — the board reads, the emit refusal seats, and the write that lands the machine. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {issue} from "../build/fixtures.test-support.ts";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import {readGoldenFixture} from "../golden-fixture.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	LANE_ABSENT,
	LANE_EXISTS,
	LANE_UNREADABLE,
	TOPOLOGY_ABSENT,
	TOPOLOGY_CYCLE,
	TOPOLOGY_FOREIGN,
} from "./codes.ts";
import {runEmit} from "./emit-verb.ts";

const ISSUE = /^gh api repos\/o\/r\/issues\/4300$/;
const SUBS = /^gh api --paginate repos\/o\/r\/issues\/4300\/sub_issues\?per_page=100$/;

const body = (): string => readGoldenFixture(import.meta.url, "./__fixtures__/epic-4300.body.txt");
const golden = (): string =>
	readGoldenFixture(import.meta.url, "./__fixtures__/epic-4300.workflow.golden.txt");

const children = okOut(
	JSON.stringify([
		{number: 4301, state: "open", state_reason: null},
		{number: 4302, state: "open", state_reason: null},
		{number: 4303, state: "open", state_reason: null},
	]),
);

const OPTIONS = {
	epic: 4300,
	root: ".fabrika/lanes",
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]>, fs = fakeFs({files: {}})) =>
	Effect.runPromise(
		Effect.provide(runEmit(OPTIONS), Layer.merge(fs.layer, fakeShell(script).layer)),
	).then((out) => ({out, fs}));

describe("lane emit", () => {
	it("writes the golden machine bytes to the epic's lane dir", async () => {
		const {out, fs} = await run([
			[ISSUE, issue({number: 4300, body: body()})],
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
				[ISSUE, issue({number: 4300, body: body()})],
				[SUBS, children],
			],
			fakeFs({files: {}, directories: [".fabrika/lanes/4300"]}),
		);

		expect(out.code).toBe(LANE_EXISTS);
		expect(fs.written.size).toBe(0);
	});

	it("refuses a proven-absent epic on the no-target seat", async () => {
		const {out} = await run([[ISSUE, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(LANE_ABSENT);
	});

	it("refuses an unreadable child list as UNKNOWN — never an epic with no children", async () => {
		const {out, fs} = await run([
			[ISSUE, issue({number: 4300, body: body()})],
			[SUBS, errOut("gh: connect: network is unreachable")],
		]);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.size).toBe(0);
	});

	it("refuses a child entry with no readable state as UNKNOWN — never a queued default", async () => {
		const {out, fs} = await run([
			[ISSUE, issue({number: 4300, body: body()})],
			[SUBS, okOut(JSON.stringify([{number: 4301}, {number: 4302}, {number: 4303}]))],
		]);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("#4301");
		expect(fs.written.size).toBe(0);
	});

	it("refuses an epic with no topology block, naming the absence", async () => {
		const {out} = await run([
			[ISSUE, issue({number: 4300, body: "## Plan\n\nno topology\n"})],
			[SUBS, children],
		]);

		expect(out.code).toBe(TOPOLOGY_ABSENT);
		expect(out.stderr.join("\n")).toContain("Dependencies");
	});

	it("refuses a topology referencing a non-child, naming the ref", async () => {
		const {out} = await run([
			[ISSUE, issue({number: 4300, body: "## Dependencies\n\n- phase 1: #9999\n"})],
			[SUBS, children],
		]);

		expect(out.code).toBe(TOPOLOGY_FOREIGN);
		expect(out.stderr.join("\n")).toContain("#9999");
	});

	it("refuses a cycle, naming the path", async () => {
		const cyclic =
			"## Dependencies\n\n- phase 1: #4301, #4302\n- #4301 requires: #4302\n- #4302 requires: #4301\n";
		const {out} = await run([
			[ISSUE, issue({number: 4300, body: cyclic})],
			[SUBS, children],
		]);

		expect(out.code).toBe(TOPOLOGY_CYCLE);
		expect(out.stderr.join("\n")).toContain("#4301");
	});

	it("keeps the emit refusal seats distinct", () => {
		expect(new Set([LANE_EXISTS, TOPOLOGY_ABSENT, TOPOLOGY_FOREIGN, TOPOLOGY_CYCLE]).size).toBe(4);
	});
});
