/**
 * The Node half of a reload (#9667): after the config is read again, an edited file the config
 * imports runs its new code, not the copy Node cached on the first read. Proved in a real `node`
 * child (`./module-generations.probe.ts`), because Vitest's own module runner stands between a test
 * and Node's loader.
 */

import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";

const probe = fileURLToPath(new URL("./module-generations.probe.ts", import.meta.url));

/** One real `node` child starting off TypeScript source; vitest's 5 s default does not cover it. */
const SPAWN_MS = 20_000;

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

interface Read {
	readonly ids: ReadonlyArray<string>;
	readonly files: ReadonlyArray<string>;
}

/** A project whose config imports a program file, which imports a second file one level down. */
const authoredProject = () => {
	const project = realpathSync(mkdtempSync(join(tmpdir(), "tuval-generations-")));
	tempDirs.push(project);
	mkdirSync(join(project, ".tuval"));
	mkdirSync(join(project, "programs"));
	writeFileSync(join(project, "package.json"), JSON.stringify({type: "module"}));
	const config = join(project, ".tuval", "tuval.config.ts");
	const program = join(project, "programs", "greeting.ts");
	const word = join(project, "programs", "word.ts");
	writeFileSync(
		config,
		'import {greeting} from "../programs/greeting.ts";\nexport default {version: 1, programs: [{id: greeting}]};\n',
	);
	writeFileSync(
		program,
		'import {word} from "./word.ts";\nexport const greeting: string = "greeting-" + word;\n',
	);
	writeFileSync(word, 'export const word: string = "first";\n');
	return {project, config, program, word};
};

describe("a config read again in the same process", () => {
	it(
		"runs the edited code of a module the config imports, not Node's cached copy",
		() => {
			const {project, config, program, word} = authoredProject();
			const result = spawnSync(
				process.execPath,
				[probe, project, word, 'export const word: string = "second";\n'],
				{encoding: "utf8"},
			);
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
			const {before, after} = JSON.parse(result.stdout) as {
				readonly before: Read;
				readonly after: Read;
			};

			expect(before.ids).toEqual(["greeting-first"]);
			expect(after.ids).toEqual(["greeting-second"]);
			// The files a desk watches: the config and everything it imports by path, on both reads.
			expect(before.files).toEqual([config, program, word]);
			expect(after.files).toEqual([config, program, word]);
		},
		SPAWN_MS,
	);
});
