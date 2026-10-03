/**
 * The desk's side of the `pi-session` row: its boot loads a project config from where
 * `projectRootOf` reads the root back. The boot is the desk's, so this case lives beside the desk
 * rather than in `@kampus/tuval-pi`, whose own tests cover the row's declarations.
 */

import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {projectRootOf} from "@kampus/tuval-pi";
import {afterAll} from "vitest";
import {projectConfig} from "../boot.ts";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const tempProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-pi-desk-")));
	tempDirs.push(dir);
	return dir;
};

describe("the pi-session program row on the desk", () => {
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
