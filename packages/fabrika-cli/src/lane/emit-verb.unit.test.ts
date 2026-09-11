/** `lane emit` — the board reads, the emit refusal seats, and the write that lands the machine. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {issuePayload, NOT_FOUND, served} from "../build/fixtures.test-support.ts";
import {fakeFs, fakeHttp, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import {readGoldenFixture} from "../golden-fixture.ts";
import {
	CLASS_UNRECOGNISED,
	LANE_ABSENT,
	LANE_EXISTS,
	LANE_UNREADABLE,
	MALFORMED_RECORD,
	TOPOLOGY_ABSENT,
	TOPOLOGY_CYCLE,
	TOPOLOGY_FOREIGN,
} from "./codes.ts";
import {type EmitOptions, runEmit} from "./emit-verb.ts";
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
	// No cap declared — the cap's own arms live in [`concurrency.unit.test.ts`](concurrency.unit.test.ts).
	cap: {_tag: "Value", value: null, note: "test"} as const,
	// The axis off — the machinery arms have their own coverage in [`emit.unit.test.ts`](emit.unit.test.ts).
	machinery: {_tag: "Value", value: {onEmit: "off"}, note: "test"} as const,
	claimed: () => Effect.succeed({_tag: "Unclaimed"} as const),
	// The descope escape off — its own arms live below, and in [`emit.unit.test.ts`](emit.unit.test.ts).
	children: false,
};

const run = (script: ReadonlyArray<readonly [RegExp, HttpReply]> = [], fs = fakeFs({files: {}})) =>
	Effect.runPromise(
		Effect.provide(
			runEmit(OPTIONS),
			Layer.mergeAll(fs.layer, fakeShell([]).layer, fakeHttp(script).layer),
		),
	).then((out) => ({out, fs}));

/** The same run with the descope escape armed — the one axis these two tests turn on. */
const runWithChildren = (
	script: ReadonlyArray<readonly [RegExp, HttpReply]>,
	fs = fakeFs({files: {}}),
) =>
	Effect.runPromise(
		Effect.provide(
			runEmit({...OPTIONS, children: true}),
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

	it("refuses a prose line inside the topology, naming it and teaching where prose belongs", async () => {
		const note = "_Shell shipped out-of-band via epic #2711._";
		const {out, fs} = await run([
			[ISSUE, epic({body: `## Dependencies\n\n- phase 1: #4301\n${note}\n`})],
			[SUBS, children],
		]);

		expect(out.code).toBe(MALFORMED_RECORD);
		expect(fs.written.size).toBe(0);
		const stderr = out.stderr.join("\n");
		expect(stderr).toContain(`line 4 does not parse: "${note}"`);
		expect(stderr).toContain("editorial or history prose belongs below a `---` thematic break");
		expect(stderr).toContain("which ends the section");
	});

	it("refuses a topology referencing a non-child, naming the ref", async () => {
		const {out} = await run([
			[ISSUE, epic({body: "## Dependencies\n\n- phase 1: #9999\n"})],
			[SUBS, children],
		]);

		expect(out.code).toBe(TOPOLOGY_FOREIGN);
		const line = out.stderr.join("\n");
		expect(line).toContain("#9999");
		// The refusal is the only place an operator meets either escape, so it names both.
		expect(line).toContain("--children");
		expect(line).toContain("ledger retopology");
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

	it("drops a descoped ref under --children and reports what went", async () => {
		const {out, fs} = await runWithChildren([
			[ISSUE, epic({body: "## Dependencies\n\n- phase 1: #4301\n- phase 2: #9999, #4302\n"})],
			[SUBS, children],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "emitted",
			children: 2,
			dropped: {count: 1, rows: ["#9999"]},
		});
		expect(out.stderr.join("\n")).toContain("#9999");
		expect(fs.written.get(WORKFLOW) ?? "").not.toContain("9999");
	});

	it("reports a long dropped list whole on both channels", async () => {
		const rows = ["#9901", "#9902", "#9903", "#9904", "#9905", "#9906", "#9907"];
		const {out} = await runWithChildren([
			[
				ISSUE,
				epic({
					body: `## Dependencies\n\n- phase 1: #4301, #4302\n- phase 2: ${rows.join(", ")}\n`,
				}),
			],
			[SUBS, children],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "emitted", dropped: {count: 7, rows}});
		expect(out.stderr.join("\n")).toContain(
			`dropped 7 ref(s) #4300's topology names and its child list does not: ${rows.join(", ")}.`,
		);
	});

	it("refuses at 15 with nothing placed when --children empties the topology", async () => {
		const {out, fs} = await runWithChildren([
			[ISSUE, epic({body: "## Dependencies\n\n- phase 1: #9999\n"})],
			[SUBS, children],
		]);

		expect(out.code).toBe(TOPOLOGY_ABSENT);
		expect(out.stderr.join("\n")).toContain("#9999");
		expect(fs.written.size).toBe(0);
	});

	it("keeps the emit refusal seats distinct", () => {
		expect(new Set([LANE_EXISTS, TOPOLOGY_ABSENT, TOPOLOGY_FOREIGN, TOPOLOGY_CYCLE]).size).toBe(4);
	});
});

describe("lane emit — the machinery lap key", () => {
	const runWith = (machinery: EmitOptions["machinery"], fs = fakeFs({files: {}})) =>
		Effect.runPromise(
			Effect.provide(
				runEmit({...OPTIONS, machinery}),
				Layer.mergeAll(
					fs.layer,
					fakeShell([]).layer,
					fakeHttp([
						[ISSUE, epic()],
						[SUBS, children],
					]).layer,
				),
			),
		).then((out) => ({out, fs}));

	it("writes the machine with the lap arms when the repo declares the axis on", async () => {
		const {out, fs} = await runWith({_tag: "Value", value: {onEmit: "on"}, note: "test"});

		expect(out.code).toBe(0);
		const written = fs.written.get(".fabrika/lanes/4300/workflow.json") ?? "";
		expect(written).not.toBe(golden());
		expect(written).toContain("human:machinery-stall");
		expect(written).toContain("lapsRemaining");
	});

	it("refuses an unreadable key as UNKNOWN, and writes no machine at all", async () => {
		const {out, fs} = await runWith({_tag: "Refused", reason: "malformed"});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("machineryLaps");
	});
});

/**
 * The class refusal — the child half of the pre-placement guard `lane open` has on its own path.
 *
 * It is proven by what is NOT on disk: an off-set spelling placed here compiles `Malformed` on every
 * later read, so it refuses every fold of the lane rather than this one boot.
 */
describe("lane emit — an off-set child class", () => {
	const labelled = (labels: ReadonlyArray<string>): HttpReply => ({
		status: 200,
		body: JSON.stringify([
			{
				number: 4301,
				state: "open",
				state_reason: null,
				labels: labels.map((name) => ({name})),
			},
			{number: 4302, state: "open", state_reason: null},
			{number: 4303, state: "open", state_reason: null},
		]),
	});

	it("refuses it before placement, names the child, and writes nothing", async () => {
		const {out, fs} = await run([
			[ISSUE, epic()],
			[SUBS, labelled(["class:UI"])],
		]);

		expect(out.code).toBe(CLASS_UNRECOGNISED);
		expect(out.stderr.join("\n")).toContain("#4301 class:UI");
		expect(fs.written.size).toBe(0);
	});

	it("seeds an on-set child's class, and places build:ui without review:ui", async () => {
		const {out, fs} = await run([
			[ISSUE, epic()],
			[SUBS, labelled(["class:ui"])],
		]);

		expect(out.code).toBe(0);
		const written = fs.written.get(".fabrika/lanes/4300/workflow.json") ?? "";
		expect(written).toContain('"classes"');
		expect(written).toContain("build:ui");
		expect(written).not.toContain("review:ui");
	});
});
