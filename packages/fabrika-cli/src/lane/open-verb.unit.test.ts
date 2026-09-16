/** `lane open` — the template boot, and the refusals that leave the disk untouched. */
import {Effect, type FileSystem, type Path} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import type {VerbOutcome} from "../verb.ts";
import {
	APPEND_UNKNOWN,
	CLASS_UNRECOGNISED,
	LANE_EXISTS,
	LANE_IS_CHILD,
	LANE_UNREADABLE,
	PRIOR_LANE,
	SHAPE_MISMATCH,
} from "./codes.ts";
import {emitMachine} from "./emit.ts";
import type {ExpectationRead} from "./expectation.ts";
import {choreTemplateText, coderTemplateText} from "./fixtures.test-support.ts";
import {runOpen} from "./open-verb.ts";
import type {PriorLane} from "./prior-lane.ts";
import {runStatus} from "./status-verb.ts";
import {DEFAULT_CHORES_ROOT} from "./store.ts";

const ROOT = ".fabrika/lanes";
const DIR = `${ROOT}/42`;
const WORKFLOW = `${DIR}/workflow.json`;
const TEMPLATE = "/pkg/src/lane/templates/coder.workflow.json";

const reads = (read: ExpectationRead) => () => Effect.succeed(read);
const childless = reads({_tag: "Read", expectation: {_tag: "Single"}, classes: []});

const PARENT = 4304;
const PARENT_DIR = `${ROOT}/${PARENT}`;
const PARENT_WORKFLOW = `${PARENT_DIR}/workflow.json`;

const childOf = (parent: number | null) =>
	reads({_tag: "Read", expectation: {_tag: "Child", parent}, classes: []});

/**
 * The parent epic's lane as `lane emit` would have written it — the real emitter, so the task ids
 * the refusal looks for are spelled by the code that spells them in production rather than by hand.
 */
const parentMachine = (...children: ReadonlyArray<number>): string => {
	const emitted = emitMachine(
		PARENT,
		["## Dependencies", "", `- phase 1: ${children.map((n) => `#${n}`).join(", ")}`].join("\n"),
		children.map((number) => ({number, state: "open" as const, stateReason: null, classes: []})),
	);
	if (emitted._tag !== "Emitted") throw new Error(`fixture did not emit: ${emitted._tag}`);
	return emitted.text;
};

const drove = (read: PriorLane) => () => Effect.succeed(read);
/** The board hangs no pull request off the issue — the lane it never had. */
const undriven = drove({_tag: "Fresh"});

/** No cap declared — the cap's own arms live in [`concurrency.unit.test.ts`](concurrency.unit.test.ts). */
const UNCAPPED = {_tag: "Value", value: null, note: "test"} as const;

const OPTIONS = {
	root: ROOT,
	lane: "42",
	templatePath: TEMPLATE,
	issue: 42,
	expectation: childless,
	priorLane: undriven,
	cap: UNCAPPED,
	claimed: () => Effect.succeed({_tag: "Unclaimed"} as const),
};

const run = (
	fs: ReturnType<typeof fakeFs>,
	eff: Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path>,
) => Effect.runPromise(Effect.provide(eff, fs.layer));

describe("lane open", () => {
	it("boots the lane with a byte-identical copy of the committed template", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(fs, runOpen(OPTIONS));

		expect(out.code).toBe(0);
		expect(fs.written.get(WORKFLOW)).toBe(coderTemplateText());
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "opened", lane: "42"});
	});

	it("seeds the placed document's context from the issue's class label", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const classed = reads({_tag: "Read", expectation: {_tag: "Single"}, classes: ["ui"]});
		const out = await run(fs, runOpen({...OPTIONS, expectation: classed}));

		expect(out.code).toBe(0);
		const placed = JSON.parse(fs.written.get(WORKFLOW) ?? "") as {
			machine: {context: {issue: {classes: ReadonlyArray<string>}}};
		};
		expect(placed.machine.context.issue.classes).toEqual(["ui"]);
		expect(JSON.parse(out.stdout)).toMatchObject({classes: ["ui"]});
		expect(out.stderr.join("\n")).toContain("seeded class:ui");
	});

	it("refuses an off-set class label before placement, leaving the disk untouched", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const misspelt = reads({_tag: "Read", expectation: {_tag: "Single"}, classes: ["UI"]});
		const out = await run(fs, runOpen({...OPTIONS, expectation: misspelt}));

		expect(out.code).toBe(CLASS_UNRECOGNISED);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("class:UI");
	});

	it("folds the freshly opened lane to its initial state through `lane status`", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		await run(fs, runOpen(OPTIONS));
		const out = await run(fs, runStatus({root: ROOT, lane: "42"}));

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			stateValue: {pipeline: {issue: "queued"}},
			status: "active",
		});
	});

	it("boots a chore lane by name and folds it, with no issue number anywhere", async () => {
		const chore = {
			root: DEFAULT_CHORES_ROOT,
			lane: "park-sweep",
			templatePath: "/pkg/src/lane/templates/chore.workflow.json",
			issue: null,
			expectation: null,
			priorLane: null,
			cap: UNCAPPED,
			claimed: () => Effect.succeed({_tag: "Unclaimed"} as const),
		};
		const fs = fakeFs({files: {[chore.templatePath]: choreTemplateText()}});
		const opened = await run(fs, runOpen(chore));
		const folded = await run(fs, runStatus({root: chore.root, lane: chore.lane}));

		expect(opened.code).toBe(0);
		expect(fs.written.get(`${DEFAULT_CHORES_ROOT}/park-sweep/workflow.json`)).toBe(
			choreTemplateText(),
		);
		expect(folded.code).toBe(0);
		expect(JSON.parse(folded.stdout)).toMatchObject({
			stateValue: {sweep: {park_sweep: "queued"}},
			status: "active",
		});
	});

	it("refuses an existing lane dir with its own code and writes nothing", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}, directories: [DIR]});
		const out = await run(fs, runOpen(OPTIONS));

		expect(out.code).toBe(LANE_EXISTS);
		expect(out.stdout).toBe("");
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("already");
	});

	it("sends an existing lane's driver at the lane, never at removing the directory", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}, directories: [DIR]});
		const out = await run(fs, runOpen(OPTIONS));
		const stderr = out.stderr.join("\n");

		expect(out.code).toBe(LANE_EXISTS);
		expect(stderr).toContain(`fabrika lane status ${OPTIONS.lane}`);
		expect(stderr).toContain("granted round recorded on the board");
		expect(stderr).not.toContain("remove the directory to rebuild it");
	});

	it("refuses when the lane dir's existence cannot be established — UNKNOWN, never a boot", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}, unprobeable: [DIR]});
		const out = await run(fs, runOpen(OPTIONS));

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.size).toBe(0);
	});

	it("refuses an unreadable template, naming it", async () => {
		const fs = fakeFs({files: {}});
		const out = await run(fs, runOpen(OPTIONS));

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain(TEMPLATE);
		expect(fs.written.size).toBe(0);
	});

	it("refuses a write that did not land — the lane is never reported opened", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}, unwritable: [WORKFLOW]});
		const out = await run(fs, runOpen(OPTIONS));

		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses an issue carrying sub-issue links before writing, naming `lane emit`", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(
			fs,
			runOpen({
				...OPTIONS,
				expectation: reads({_tag: "Read", expectation: {_tag: "Epic", children: 3}, classes: []}),
			}),
		);

		expect(out.code).toBe(SHAPE_MISMATCH);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("fabrika lane emit 42");
		expect(out.stderr.join("\n")).toContain("plan the epic first");
	});

	it("refuses a `type:epic` issue that has no children yet — the pre-plan window", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(
			fs,
			runOpen({
				...OPTIONS,
				expectation: reads({_tag: "Read", expectation: {_tag: "Epic", children: 0}, classes: []}),
			}),
		);

		expect(out.code).toBe(SHAPE_MISMATCH);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("plan the epic first");
		expect(out.stderr.join("\n")).toContain("no sub-issue links");
	});

	it("refuses a child its parent's machine holds, naming the parent's lane as the one to drive", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), [PARENT_WORKFLOW]: parentMachine(42, 43)},
		});
		const out = await run(fs, runOpen({...OPTIONS, expectation: childOf(PARENT)}));

		expect(out.code).toBe(LANE_IS_CHILD);
		expect(fs.written.size).toBe(0);
		const said = out.stderr.join("\n");
		expect(said).toContain("#42 hangs under #4304");
		expect(said).toContain("carries it as task `issue_42`");
		expect(said).toContain("fabrika lane status 4304");
		expect(said).not.toContain("fabrika lane amend");
	});

	it("names the amend route for a child linked after its parent's lane was emitted", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), [PARENT_WORKFLOW]: parentMachine(43, 44)},
		});
		const out = await run(fs, runOpen({...OPTIONS, expectation: childOf(PARENT)}));

		expect(out.code).toBe(LANE_IS_CHILD);
		expect(fs.written.size).toBe(0);
		const said = out.stderr.join("\n");
		expect(said).toContain("holds no task `issue_42`");
		expect(said).toContain("`## Dependencies`");
		expect(said).toContain("fabrika lane amend 4304");
		expect(said).not.toContain("carries it as task");
	});

	it("refuses fail-closed when the parent lane is not on disk — UNKNOWN, never proven absence", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(fs, runOpen({...OPTIONS, expectation: childOf(PARENT)}));

		expect(out.code).toBe(LANE_IS_CHILD);
		expect(fs.written.size).toBe(0);
		const said = out.stderr.join("\n");
		expect(said).toContain("UNKNOWN");
		expect(said).toContain(`no lane is on disk at ${PARENT_DIR}`);
		expect(said).not.toContain("holds no task");
		expect(said).not.toContain("carries it as task");
	});

	it("reads an unreadable parent machine as UNKNOWN, naming the path", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), [PARENT_WORKFLOW]: parentMachine(42)},
			unreadable: [PARENT_WORKFLOW],
		});
		const out = await run(fs, runOpen({...OPTIONS, expectation: childOf(PARENT)}));

		expect(out.code).toBe(LANE_IS_CHILD);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
		expect(out.stderr.join("\n")).toContain(PARENT_WORKFLOW);
	});

	it("reads a malformed parent machine as UNKNOWN rather than as an empty task set", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText(), [PARENT_WORKFLOW]: "{"}});
		const out = await run(fs, runOpen({...OPTIONS, expectation: childOf(PARENT)}));

		expect(out.code).toBe(LANE_IS_CHILD);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
		expect(out.stderr.join("\n")).toContain("does not compile");
	});

	it("refuses a child whose parent number the board did not carry, with no lane to look in", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(fs, runOpen({...OPTIONS, expectation: childOf(null)}));

		expect(out.code).toBe(LANE_IS_CHILD);
		expect(fs.written.size).toBe(0);
		const said = out.stderr.join("\n");
		expect(said).toContain("hangs under a parent issue");
		expect(said).toContain("UNKNOWN");
		expect(said).toContain("no parent number that reads");
	});

	it("boots a parentless issue, unchanged by the child guard", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(fs, runOpen(OPTIONS));

		expect(out.code).toBe(0);
		expect(fs.written.get(WORKFLOW)).toBe(coderTemplateText());
	});

	it("refuses an unreadable child list — UNKNOWN, never a boot", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(
			fs,
			runOpen({...OPTIONS, expectation: reads({_tag: "Unknown", reason: "the API answered 502"})}),
		);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("502");
	});

	it("boots offline when no reader is passed, asking the board nothing", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(fs, runOpen({...OPTIONS, expectation: null, priorLane: null}));

		expect(out.code).toBe(0);
		expect(fs.written.get(WORKFLOW)).toBe(coderTemplateText());
	});

	it("refuses an issue the board says already had a lane, naming the PRs and the granted round", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(
			fs,
			runOpen({...OPTIONS, priorLane: drove({_tag: "Prior", pulls: [7991]})}),
		);

		expect(out.code).toBe(PRIOR_LANE);
		expect(out.stdout).toBe("");
		expect(fs.written.size).toBe(0);
		const said = out.stderr.join("\n");
		expect(said).toContain("#42 already had a lane");
		expect(said).toContain("#7991");
		expect(said).toContain("build clear 7991");
		expect(said).toContain("Nothing was written.");
	});

	it("boots a lane retired for the wrong template — the sanctioned retire, which opened no PR", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(fs, runOpen({...OPTIONS, priorLane: undriven}));

		expect(out.code).toBe(0);
		expect(fs.written.get(WORKFLOW)).toBe(coderTemplateText());
	});

	it("refuses when the prior-lane fact cannot be established — UNKNOWN, never a fresh lane", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(
			fs,
			runOpen({...OPTIONS, priorLane: drove({_tag: "Unknown", reason: "the API answered 502"})}),
		);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("502");
	});

	it("leaves an existing lane dir answering its own code, without asking the board at all", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}, directories: [DIR]});
		let asked = 0;
		const out = await run(
			fs,
			runOpen({
				...OPTIONS,
				priorLane: () => {
					asked += 1;
					return Effect.succeed({_tag: "Prior", pulls: [7991]} as const);
				},
			}),
		);

		expect(out.code).toBe(LANE_EXISTS);
		expect(asked).toBe(0);
		expect(fs.written.size).toBe(0);
	});
});
