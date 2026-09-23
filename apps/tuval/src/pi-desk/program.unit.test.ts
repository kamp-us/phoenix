/**
 * The desk's side of the `pi-session` row: its picker lists the row, and its boot loads a project
 * config from where `projectRootOf` reads the root back. Both are the desk's, so these cases live
 * beside the desk rather than in `@kampus/tuval-pi`, whose own tests cover the row's declarations.
 */

import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {PI_SESSION_PROGRAM, piSessionProgram, projectRootOf} from "@kampus/tuval-pi";
import {ScriptedAiAgent} from "@kampus/tuval-sdk/kernel/ai-agent/service/index";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {afterAll} from "vitest";
import {projectConfig} from "../boot.ts";
import {programEntries, showsInAWindow} from "../shell/picker/entries.ts";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const tempProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-pi-desk-")));
	tempDirs.push(dir);
	return dir;
};

const script = {
	sessionId: "pi-desk-test",
	history: [],
	modes: {current: null, available: []},
	models: {current: null, available: []},
	thinking: {current: null, available: []},
	interrupt: [],
	turns: [],
};

describe("the pi-session program row on the desk", () => {
	it("shows in the picker, which is what declaring a renderer buys the row", () => {
		const declared = piSessionProgram({cwd: tempProject(), layer: ScriptedAiAgent.layer(script)});
		assert.isTrue(showsInAWindow(declared));
		assert.deepStrictEqual(
			programEntries([declared]).map((entry) => entry.programId),
			[ProgramId.make(PI_SESSION_PROGRAM)],
			"a row the picker leaves out is a program nobody can open a window on",
		);
	});

	it("reads the project root back off the config module boot loads", () => {
		const project = tempProject();
		const moduleUrl = pathToFileURL(projectConfig(project));
		assert.strictEqual(
			projectRootOf(moduleUrl),
			project,
			"a project config module does not read back the root boot loaded it from",
		);
		assert.strictEqual(projectRootOf(moduleUrl.href), project);
	});
});
