/**
 * The desk's side of the `agy-session` row: its picker lists the row. The picker is the desk's, so
 * this case lives beside the desk rather than in `@kampus/tuval-agy`, whose own tests cover the
 * row's declarations.
 */

import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {AGY_SESSION_PROGRAM, agySessionProgram} from "@kampus/tuval-agy";
import {ScriptedAiAgent} from "@kampus/tuval-sdk/kernel/ai-agent/service/index";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {afterAll} from "vitest";
import {programEntries, showsInAWindow} from "../shell/picker/entries.ts";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const tempProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-agy-desk-")));
	tempDirs.push(dir);
	return dir;
};

const script = {
	sessionId: "agy-desk-test",
	history: [],
	modes: {current: null, available: []},
	models: {current: null, available: []},
	thinking: {current: null, available: []},
	interrupt: [],
	turns: [],
};

describe("the agy-session program row on the desk", () => {
	it("shows in the picker, which is what declaring a renderer buys the row", () => {
		const declared = agySessionProgram({cwd: tempProject(), layer: ScriptedAiAgent.layer(script)});
		assert.isTrue(showsInAWindow(declared));
		assert.deepStrictEqual(
			programEntries([declared]).map((entry) => entry.programId),
			[ProgramId.make(AGY_SESSION_PROGRAM)],
			"a row the picker leaves out is a program nobody can open a window on",
		);
	});
});
