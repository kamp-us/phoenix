/** `lane open` — the template boot, and the refusals that leave the disk untouched. */
import {Effect, type FileSystem, type Path} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import type {VerbOutcome} from "../verb.ts";
import {
	APPEND_UNKNOWN,
	LANE_EXISTS,
	LANE_IS_CHILD,
	LANE_UNREADABLE,
	SHAPE_MISMATCH,
} from "./codes.ts";
import type {ExpectationRead} from "./expectation.ts";
import {choreTemplateText, coderTemplateText} from "./fixtures.test-support.ts";
import {runOpen} from "./open-verb.ts";
import {runStatus} from "./status-verb.ts";
import {DEFAULT_CHORES_ROOT} from "./store.ts";

const ROOT = ".fabrika/lanes";
const DIR = `${ROOT}/42`;
const WORKFLOW = `${DIR}/workflow.json`;
const TEMPLATE = "/pkg/src/lane/templates/coder.workflow.json";

const reads = (read: ExpectationRead) => () => Effect.succeed(read);
const childless = reads({_tag: "Read", expectation: {_tag: "Single"}});

const OPTIONS = {
	root: ROOT,
	lane: "42",
	templatePath: TEMPLATE,
	issue: 42,
	expectation: childless,
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
				expectation: reads({_tag: "Read", expectation: {_tag: "Epic", children: 3}}),
			}),
		);

		expect(out.code).toBe(SHAPE_MISMATCH);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("fabrika lane emit 42");
		expect(out.stderr.join("\n")).toContain("plan the epic first");
	});

	it("refuses a `type:epic` issue that has no children yet — #7024's pre-plan window", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(
			fs,
			runOpen({
				...OPTIONS,
				expectation: reads({_tag: "Read", expectation: {_tag: "Epic", children: 0}}),
			}),
		);

		expect(out.code).toBe(SHAPE_MISMATCH);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("plan the epic first");
		expect(out.stderr.join("\n")).toContain("no sub-issue links");
	});

	it("refuses an epic's child, naming the parent's lane as the one to drive", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(
			fs,
			runOpen({
				...OPTIONS,
				expectation: reads({_tag: "Read", expectation: {_tag: "Child", parent: 4304}}),
			}),
		);

		expect(out.code).toBe(LANE_IS_CHILD);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("#42 hangs under #4304");
		expect(out.stderr.join("\n")).toContain("fabrika lane status 4304");
	});

	it("refuses a child whose parent number the board did not carry", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}});
		const out = await run(
			fs,
			runOpen({
				...OPTIONS,
				expectation: reads({_tag: "Read", expectation: {_tag: "Child", parent: null}}),
			}),
		);

		expect(out.code).toBe(LANE_IS_CHILD);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("hangs under a parent issue");
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
		const out = await run(fs, runOpen({...OPTIONS, expectation: null}));

		expect(out.code).toBe(0);
		expect(fs.written.get(WORKFLOW)).toBe(coderTemplateText());
	});
});
