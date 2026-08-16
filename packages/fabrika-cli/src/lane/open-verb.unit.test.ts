/** `lane open` — the template boot, and the refusals that leave the disk untouched. */
import {Effect, type FileSystem, type Path} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import type {VerbOutcome} from "../verb.ts";
import {APPEND_UNKNOWN, LANE_EXISTS, LANE_UNREADABLE} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runOpen} from "./open-verb.ts";
import {runStatus} from "./status-verb.ts";

const ROOT = ".fabrika/lanes";
const DIR = `${ROOT}/42`;
const WORKFLOW = `${DIR}/workflow.json`;
const TEMPLATE = "/pkg/src/lane/templates/coder.workflow.json";

const OPTIONS = {root: ROOT, lane: "42", templatePath: TEMPLATE};

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
});
