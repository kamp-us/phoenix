/**
 * The key encoding and the one-time move, read on their own: `boot.unit.test.ts` proves what a real
 * boot does with them, and this file proves the two rules that boot cannot show — that two paths
 * are never one directory, and that a directory refuses a second project's claim on it.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
	renderAdoption,
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

	it("keeps a dash beside a separator apart from one on the other side of it", () => {
		// The shape the first encoding lost: escaping a dash to a longer run of dashes leaves a run
		// ambiguous between the two productions, and both of these collided on `-a---b`.
		assert.notStrictEqual(projectKey("/a-/b"), projectKey("/a/-b"));
		assert.notStrictEqual(projectKey("/x/-y"), projectKey("/x-/y"));
	});

	it("is injective over every short path built from a separator, a dash and an underscore", () => {
		// An exhaustive proof of ADR 0402 rule 4 over the alphabet that can collide at all: the
		// escape's own two characters, the separator, and one ordinary character to carry them.
		const alphabet = ["a", "-", "_", "/"];
		const paths: Array<string> = [];
		const extend = (path: string, left: number) => {
			paths.push(path);
			if (left === 0) return;
			for (const char of alphabet) extend(path + char, left - 1);
		};
		extend("/", 5);
		const keys = new Set(paths.map((path) => projectKey(path)));
		assert.strictEqual(keys.size, paths.length);
	});

	it("spends one folder name on a path, never a nested tree", () => {
		assert.notInclude(projectKey("/Users/someone/code/phoenix"), "/");
	});

	it("fits a path far longer than one filename allows, and still keeps two of them apart", () => {
		const long = `/${"segment/".repeat(60)}`;
		assert.isAtMost(Buffer.byteLength(projectKey(long)), 255);
		assert.notStrictEqual(projectKey(long), projectKey(`${long}other`));
	});

	it("elides on a marker no escape can emit, so an elided key is never a plain one", () => {
		// A head cut through an escape pair would leave a lone `_`, and `__` before the digest reads
		// as a plain escaped underscore instead of the elision marker.
		const key = projectKey(`/${"-".repeat(300)}`);
		assert.match(key, /_[0-9a-f]{32}$/);
		assert.notInclude(key, "__");
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
	it.effect("lifts the names Tuval writes, and moves nothing on a second run", () =>
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
			// The config module comes back under the same field as any other unrecognised name: it is
			// left because it is outside the set, not by a skip of its own.
			assert.deepStrictEqual(first.unowned, ["tuval.config.ts"]);
			assert.isTrue(existsSync(join(projectTuval, "tuval.config.ts")));
			assert.isFalse(existsSync(join(stateDir, "tuval.config.ts")));
			assert.strictEqual(readFileSync(join(stateDir, "processes", "p-1.json"), "utf8"), "{}\n");

			const second = yield* adoptInProjectState(projectTuval, stateDir);
			assert.deepStrictEqual(second, {moved: [], kept: [], unowned: ["tuval.config.ts"]});
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("leaves a file the operator parked there, and never copies it into the state dir", () =>
		Effect.gen(function* () {
			const project = freshDir("tuval-state-project-");
			const stateDir = join(freshDir("tuval-state-home-"), "state");
			const projectTuval = join(project, ".tuval");
			mkdirSync(projectTuval, {recursive: true});
			mkdirSync(stateDir, {recursive: true});
			writeFileSync(join(projectTuval, "manifest.json"), "{}\n");
			writeFileSync(join(projectTuval, "notes.md"), "mine\n");
			mkdirSync(join(projectTuval, "scratch"), {recursive: true});

			const adopted = yield* adoptInProjectState(projectTuval, stateDir);
			assert.deepStrictEqual(adopted.moved, ["manifest.json"]);
			assert.deepStrictEqual([...adopted.unowned].sort(), ["notes.md", "scratch"]);
			assert.strictEqual(readFileSync(join(projectTuval, "notes.md"), "utf8"), "mine\n");
			assert.isTrue(existsSync(join(projectTuval, "scratch")));
			assert.isFalse(existsSync(join(stateDir, "notes.md")));
			assert.isFalse(existsSync(join(stateDir, "scratch")));
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("reports a collision and an unowned name under their own fields", () =>
		Effect.gen(function* () {
			const project = freshDir("tuval-state-project-");
			const stateDir = join(freshDir("tuval-state-home-"), "state");
			const projectTuval = join(project, ".tuval");
			mkdirSync(projectTuval, {recursive: true});
			mkdirSync(stateDir, {recursive: true});
			writeFileSync(join(projectTuval, "manifest.json"), "the project's\n");
			writeFileSync(join(stateDir, "manifest.json"), "the desk's\n");
			writeFileSync(join(projectTuval, "notes.md"), "mine\n");

			const adopted = yield* adoptInProjectState(projectTuval, stateDir);
			assert.deepStrictEqual(adopted, {
				moved: [],
				kept: ["manifest.json"],
				unowned: ["notes.md"],
			});
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
			assert.deepStrictEqual(adopted, {moved: [], kept: ["manifest.json"], unowned: []});
			assert.strictEqual(readFileSync(join(stateDir, "manifest.json"), "utf8"), "the desk's\n");
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("has nothing to do for a project that never had a `.tuval/` at all", () =>
		Effect.gen(function* () {
			const project = freshDir("tuval-state-project-");
			const stateDir = join(freshDir("tuval-state-home-"), "state");
			const adopted = yield* adoptInProjectState(join(project, ".tuval"), stateDir);
			assert.deepStrictEqual(adopted, {moved: [], kept: [], unowned: []});
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});

describe("the boot lines one adoption earns", () => {
	it.effect("says nothing on the repeat boot of a project that holds only its config module", () =>
		Effect.gen(function* () {
			const project = freshDir("tuval-state-project-");
			const stateDir = join(freshDir("tuval-state-home-"), "state");
			const projectTuval = join(project, ".tuval");
			mkdirSync(projectTuval, {recursive: true});
			mkdirSync(stateDir, {recursive: true});
			writeFileSync(join(projectTuval, "tuval.config.ts"), "export default {};\n");

			const adopted = yield* adoptInProjectState(projectTuval, stateDir);
			// The field still reports the config module — what changed is that nothing prints it.
			assert.deepStrictEqual(adopted, {moved: [], kept: [], unowned: ["tuval.config.ts"]});
			assert.deepStrictEqual(renderAdoption(adopted, stateDir), []);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("names what the move took and what it left, on the boot that moved something", () =>
		Effect.gen(function* () {
			const project = freshDir("tuval-state-project-");
			const stateDir = join(freshDir("tuval-state-home-"), "state");
			const projectTuval = join(project, ".tuval");
			mkdirSync(projectTuval, {recursive: true});
			mkdirSync(stateDir, {recursive: true});
			writeFileSync(join(projectTuval, "manifest.json"), "{}\n");
			writeFileSync(join(projectTuval, "tuval.config.ts"), "export default {};\n");
			writeFileSync(join(projectTuval, "notes.md"), "mine\n");

			const adopted = yield* adoptInProjectState(projectTuval, stateDir);
			assert.deepStrictEqual(adopted.moved, ["manifest.json"]);
			assert.deepStrictEqual([...adopted.unowned].sort(), ["notes.md", "tuval.config.ts"].sort());
			assert.deepStrictEqual(renderAdoption(adopted, stateDir), [
				`moved manifest.json out of the project into ${stateDir}`,
				`left ${adopted.unowned.join(", ")} in the project — Tuval moves only the state it wrote itself`,
			]);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it("still names a collision on a boot that moved nothing, since it asks for a hand fix", () => {
		assert.deepStrictEqual(
			renderAdoption({moved: [], kept: ["manifest.json"], unowned: ["notes.md"]}, "/state"),
			["left manifest.json in the project — /state already holds one of each"],
		);
	});
});
