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
import {fileStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {Effect} from "effect";
import {afterEach} from "vitest";
import {ProjectId} from "../project-id.ts";
import {SCOPED_IDS_MARKER, scopeCheckpoints} from "./scope-checkpoints.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const project = ProjectId.of("/work/alpha");

/** A state dir holding what a build before #9684 saved: one entry per `[id, programId, parent]`. */
const seeded = (entries: ReadonlyArray<readonly [string, string, string | null]>) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-scope-")));
	dirs.push(dir);
	mkdirSync(join(dir, "processes"));
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({
			processes: entries.map(([id, programId, parentId]) => ({id, programId, parentId})),
		}),
	);
	for (const [id, programId] of entries) {
		writeFileSync(
			join(dir, "processes", `${id}.json`),
			JSON.stringify({programId, version: "1.0.0", state: {id}}),
		);
	}
	return dir;
};

const manifestOf = (dir: string) =>
	JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).processes;

const move = (dir: string) =>
	scopeCheckpoints(dir, fileStores(dir), project, {
		programs: new Set(["counter"]),
		nodes: new Set(["main"]),
	}).pipe(Effect.provide(NodeFileSystem.layer));

describe("scopeCheckpoints", () => {
	it.effect("moves project rows and nodes onto scoped ids and leaves global rows bare", () =>
		Effect.gen(function* () {
			const dir = seeded([
				["main", "counter", null],
				["logger", "log", "main"],
			]);
			const scoping = yield* move(dir);
			assert.deepStrictEqual(scoping.moved, [{from: "main", to: project.scope("main")}]);
			assert.deepStrictEqual(manifestOf(dir), [
				{id: project.scope("main"), programId: project.scope("counter"), parentId: null},
				// A global row's process keeps its id and program; only its parent link follows the move.
				{id: "logger", programId: "log", parentId: project.scope("main")},
			]);
			const moved = JSON.parse(
				readFileSync(join(dir, "processes", `${project.scope("main")}.json`), "utf8"),
			);
			assert.deepStrictEqual(moved, {
				programId: project.scope("counter"),
				version: "1.0.0",
				state: {id: "main"},
			});
			assert.isFalse(existsSync(join(dir, "processes", "main.json")));
			assert.isTrue(existsSync(join(dir, SCOPED_IDS_MARKER)));
		}),
	);

	it.effect("runs once: after the marker, a bare id is a global row's and stays where it is", () =>
		Effect.gen(function* () {
			const dir = seeded([]);
			yield* move(dir);
			// A global `counter` checkpointed after the move, beside the project's scoped one.
			writeFileSync(
				join(dir, "manifest.json"),
				JSON.stringify({processes: [{id: "g-1", programId: "counter", parentId: null}]}),
			);
			const again = yield* move(dir);
			assert.deepStrictEqual(again.moved, []);
			assert.deepStrictEqual(manifestOf(dir), [{id: "g-1", programId: "counter", parentId: null}]);
		}),
	);

	it.effect("marks a directory with no checkpoints at all as scoped", () =>
		Effect.gen(function* () {
			const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-scope-")));
			dirs.push(dir);
			assert.deepStrictEqual((yield* move(dir)).moved, []);
			assert.isTrue(existsSync(join(dir, SCOPED_IDS_MARKER)));
		}),
	);
});
