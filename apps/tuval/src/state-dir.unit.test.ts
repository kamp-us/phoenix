/**
 * The key encoding and the one-time move, read on their own: `boot.unit.test.ts` proves what a real
 * boot does with them, and this file proves the two rules that boot cannot show — that two paths
 * are never one directory, and that a directory refuses a second project's claim on it.
 */

import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import {afterEach} from "vitest";
import {
	adoptInProjectState,
	homeStateDir,
	homeTuvalDir,
	PROJECT_MARKER,
	piSessionStore,
	prepareStateDir,
	projectKey,
	StateKeyCollision,
} from "./state-dir.ts";

const tempDirs: string[] = [];
const freshDir = (prefix: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

describe("the project key", () => {
	it("keeps two paths apart that a plain separator substitution would collide", () => {
		// The case Claude Code's encoding loses: a dash already in the path reads as a separator.
		assert.notStrictEqual(projectKey("/a-b/c"), projectKey("/a/b/c"));
	});

	it("spends one folder name on a path, never a nested tree", () => {
		assert.notInclude(projectKey("/Users/someone/code/phoenix"), "/");
	});

	it("fits a path far longer than one filename allows, and still keeps two of them apart", () => {
		const long = `/${"segment/".repeat(60)}`;
		assert.isAtMost(Buffer.byteLength(projectKey(long)), 255);
		assert.notStrictEqual(projectKey(long), projectKey(`${long}other`));
	});

	it("puts every project's state under one home-dir tree, and the sessions inside that", () => {
		const dir = homeStateDir("/w/one", "/home/u");
		assert.isTrue(dir.startsWith(join(homeTuvalDir("/home/u"), "projects")));
		assert.strictEqual(piSessionStore(dir), join(dir, "pi-sessions"));
	});
});

describe("the state directory", () => {
	it.effect("records the absolute path its key was derived from", () =>
		Effect.gen(function* () {
			const home = freshDir("tuval-state-home-");
			const project = freshDir("tuval-state-project-");
			const dir = yield* prepareStateDir(project, homeStateDir(project, home));
			assert.deepStrictEqual(JSON.parse(readFileSync(join(dir, PROJECT_MARKER), "utf8")), {
				path: project,
			});
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("refuses a directory another project already recorded itself in", () =>
		Effect.gen(function* () {
			const home = freshDir("tuval-state-home-");
			const one = freshDir("tuval-state-project-");
			const dir = yield* prepareStateDir(one, homeStateDir(one, home));
			const exit = yield* Effect.exit(prepareStateDir("/somewhere/else", dir));
			assert.isTrue(Exit.isFailure(exit));
			const failure = Exit.isFailure(exit) ? exit.cause : null;
			assert.include(String(failure), StateKeyCollision.name);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});

describe("the one-time move of in-project state", () => {
	it.effect("lifts everything but the config module, and moves nothing on a second run", () =>
		Effect.gen(function* () {
			const project = freshDir("tuval-state-project-");
			const stateDir = join(freshDir("tuval-state-home-"), "state");
			const projectTuval = join(project, ".tuval");
			mkdirSync(join(projectTuval, "processes"), {recursive: true});
			writeFileSync(join(projectTuval, "tuval.config.ts"), "export default {};\n");
			writeFileSync(join(projectTuval, "manifest.json"), "{}\n");
			writeFileSync(join(projectTuval, "processes", "p-1.json"), "{}\n");
			mkdirSync(stateDir, {recursive: true});

			const first = yield* adoptInProjectState(projectTuval, stateDir);
			assert.deepStrictEqual([...first.moved].sort(), ["manifest.json", "processes"]);
			assert.deepStrictEqual(first.kept, []);
			assert.strictEqual(readFileSync(join(stateDir, "processes", "p-1.json"), "utf8"), "{}\n");

			const second = yield* adoptInProjectState(projectTuval, stateDir);
			assert.deepStrictEqual(second, {moved: [], kept: []});
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("leaves an entry the home-dir key already holds where it is, rather than over it", () =>
		Effect.gen(function* () {
			const project = freshDir("tuval-state-project-");
			const stateDir = join(freshDir("tuval-state-home-"), "state");
			const projectTuval = join(project, ".tuval");
			mkdirSync(projectTuval, {recursive: true});
			mkdirSync(stateDir, {recursive: true});
			writeFileSync(join(projectTuval, "manifest.json"), "the project's\n");
			writeFileSync(join(stateDir, "manifest.json"), "the desk's\n");

			const adopted = yield* adoptInProjectState(projectTuval, stateDir);
			assert.deepStrictEqual(adopted, {moved: [], kept: ["manifest.json"]});
			assert.strictEqual(readFileSync(join(stateDir, "manifest.json"), "utf8"), "the desk's\n");
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("has nothing to do for a project that never had a `.tuval/` at all", () =>
		Effect.gen(function* () {
			const project = freshDir("tuval-state-project-");
			const stateDir = join(freshDir("tuval-state-home-"), "state");
			const adopted = yield* adoptInProjectState(join(project, ".tuval"), stateDir);
			assert.deepStrictEqual(adopted, {moved: [], kept: []});
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
