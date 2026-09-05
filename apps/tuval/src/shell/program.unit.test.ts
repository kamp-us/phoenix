/**
 * The shell as a program row. Two halves: the row itself and its place in the box's config module,
 * and the durability the kernel gives it for free — a desk that comes back byte-equal, a window
 * whose process did not, and a snapshot from another definition that refuses the boot.
 *
 * The reload half runs over `memoryStores()` rather than the file store on purpose: a reload is a
 * second kernel built over the same store objects, which is exactly what a restart is minus the
 * filesystem, so the proof is about the shell's state and not about `fileStore`'s bytes.
 */

import {mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option} from "effect";
import {afterAll} from "vitest";
import {boot, projectDir} from "../boot.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {SnapshotRefused} from "../durability/errors.ts";
import {memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {ProcessId} from "../process/process.ts";
import type {AnyProgram} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {applyMsg, initialState, type ShellMsg} from "./core/index.ts";
import {defaultPrefixTable} from "./keys/index.ts";
import {
	SHELL_VERSION,
	shellId,
	shellNode,
	shellProgram,
	shellStateOf,
	unwiredShellEffects,
	windowBindings,
} from "./program.ts";
import {WindowId} from "./window/index.ts";

/** The box's own config module — the user-owned surface the shell is registered through. */
const boxConfig = fileURLToPath(new URL("../../.tuval/tuval.config.ts", import.meta.url));

const tempDirs: string[] = [];
/** A project dir whose `.tuval/` is empty: no project config, nothing checkpointed. */
const freshProject = () => {
	// realpath: macOS resolves /var to /private/var, and boot reports the dir it is given.
	const project = realpathSync(mkdtempSync(join(tmpdir(), "tuval-shell-")));
	mkdirSync(projectDir(project));
	tempDirs.push(project);
	return project;
};

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const row = (): AnyProgram => shellProgram({effects: unwiredShellEffects});

/** The row under another definition version, which is what a snapshot is checked against. */
const bumped = (version: string): AnyProgram => {
	const base = row();
	return {...base, identity: {...base.identity, version}};
};

const kernel = (rows: ReadonlyArray<AnyProgram>, stores: ReturnType<typeof memoryStores>) =>
	Processes.layer.pipe(
		Layer.provideMerge(Checkpoints.layer(stores)),
		Layer.provide(Registry.layer(rows)),
	);

/** The id the graph node plans, and so the id the shell's checkpoint lives under. */
const shellProcess = ProcessId.make(shellNode);

const dispatched = (...msgs: ReadonlyArray<ShellMsg>) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		const shell = yield* processes.spawn(shellId, {id: shellProcess, services: Context.empty()});
		for (const msg of msgs) yield* shell.dispatch(msg);
		const state = shellStateOf(shell.getState());
		// `Effect.die`, not `throw`: a bare throw inside an `Effect.gen` escapes the E channel as an
		// uncatchable defect (#2736, the repo's Effect lint plugin).
		if (state === null) return yield* Effect.die("the shell handed back no shell state");
		return state;
	});

describe("the shell as a program row", () => {
	it.effect("is registered through the user-owned config module and spawns as a lone root", () =>
		Effect.gen(function* () {
			const {kernel: context} = yield* boot({global: boxConfig, project: freshProject()});
			const registered = yield* Registry.use((registry) => registry.resolve(shellId)).pipe(
				Effect.provideContext(context),
			);
			assert.strictEqual(registered.id, shellId);

			const rows = yield* ProcessTable.use((table) => table.list).pipe(
				Effect.provideContext(context),
			);
			const shells = rows.filter((process) => process.programId === shellId);
			assert.strictEqual(shells.length, 1);
			assert.isTrue(Option.isNone(shells[0]!.parentId));
		}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
	);

	it("declares no port, requests no capability, names its renderer and is placed where the kernel runs", () => {
		const shell = row();
		assert.deepStrictEqual(shell.ports, {});
		assert.deepStrictEqual(shell.capabilities, []);
		assert.deepStrictEqual(shell.renderer, {kind: "host-native", ref: "tuval/shell"});
		// The kernel's word for the Node host is `local`; there is no `node` arm on `Placement`.
		assert.deepStrictEqual(shell.placement, {host: "local"});
		assert.strictEqual(shell.identity.version, SHELL_VERSION);
	});

	it.effect("brings workspaces, layouts, focus and per-window view state back byte-equal", () => {
		const stores = memoryStores();
		return Effect.gen(function* () {
			const before = yield* dispatched(
				{type: "window.split", orientation: "horizontal"},
				{type: "window.bind", processId: "counter"},
				{type: "window.setView", view: {scroll: 42}},
				{type: "workspace.create"},
				{type: "window.split", orientation: "vertical"},
				{type: "window.setView", view: {scroll: 7}},
			).pipe(Effect.provide(kernel([row()], stores)), Effect.scoped);

			const after = yield* dispatched().pipe(
				Effect.provide(kernel([row()], stores)),
				Effect.scoped,
			);

			assert.strictEqual(JSON.stringify(after), JSON.stringify(before));
			assert.strictEqual(Object.keys(after.workspaces).length, 2);
			assert.deepStrictEqual(Object.values(after.views), [{scroll: 42}, {scroll: 7}]);
		});
	});

	it("keeps a restored window whose process id no longer resolves, pointing at ProcessGone", () => {
		let state = initialState();
		[state] = applyMsg(defaultPrefixTable, state, {type: "window.bind", processId: "counter"});
		[state] = applyMsg(defaultPrefixTable, state, {
			type: "window.split",
			orientation: "horizontal",
		});
		[state] = applyMsg(defaultPrefixTable, state, {type: "window.bind", processId: "ghost"});

		const bindings = windowBindings(state, new Set([ProcessId.make("counter")]));
		assert.deepStrictEqual(
			[...bindings.values()].map((binding) => binding._tag),
			["Live", "ProcessGone"],
		);
		const gone = bindings.get(WindowId.make("window-1"));
		assert.deepStrictEqual(gone, {_tag: "ProcessGone", processId: ProcessId.make("ghost")});
	});

	it("answers Empty for a window with no process, so the surface shows the picker", () => {
		const bindings = windowBindings(initialState(), new Set());
		assert.deepStrictEqual([...bindings.values()], [{_tag: "Empty"}]);
	});

	it("refuses a version-matched snapshot whose interior is the wrong shape", () => {
		const sound = initialState();
		assert.deepStrictEqual(shellStateOf(structuredClone(sound)), sound);

		const workspaceId = sound.order[0]!;
		const workspace = sound.workspaces[workspaceId]!;
		// Every corruption below keeps all eight top-level types intact, so each one is a snapshot
		// the version check admits and only a total guard can refuse.
		const corrupt: ReadonlyArray<readonly [string, unknown]> = [
			["a workspace that is not one", {...sound, workspaces: {[workspaceId]: {id: workspaceId}}}],
			[
				"a layout node with an unknown orientation",
				{
					...sound,
					workspaces: {
						[workspaceId]: {
							...workspace,
							layout: {...workspace.layout, root: {...workspace.layout.root, orientation: "up"}},
						},
					},
				},
			],
			["an order entry that is not an id", {...sound, order: [1]}],
			["a view slot holding something JSON cannot", {...sound, views: {"window-0": () => 1}}],
			["a prefix that is neither armed nor disarmed", {...sound, prefix: {armed: "yes"}}],
		];

		assert.deepStrictEqual(
			corrupt.map(([name, snapshot]) => `${name}: ${shellStateOf(snapshot)}`),
			corrupt.map(([name]) => `${name}: null`),
		);
	});

	it.effect("refuses a snapshot from another definition and never fresh-boots over it", () => {
		const stores = memoryStores();
		return Effect.gen(function* () {
			yield* dispatched({type: "workspace.create"}).pipe(
				Effect.provide(kernel([row()], stores)),
				Effect.scoped,
			);

			const outcome = yield* Effect.gen(function* () {
				const processes = yield* Processes;
				const table = yield* ProcessTable;
				const failure = yield* Effect.flip(
					processes.spawn(shellId, {id: shellProcess, services: Context.empty()}),
				);
				return {failure, live: (yield* table.list).length};
			}).pipe(Effect.provide(kernel([bumped("2.0.0")], stores)), Effect.scoped);

			assert.instanceOf(outcome.failure, SnapshotRefused);
			assert.strictEqual(
				outcome.failure.message,
				`snapshot for process "shell" refused: written by shell@${SHELL_VERSION}, the program is now shell@2.0.0`,
			);
			assert.strictEqual(outcome.live, 0);
		});
	});

	it("holds no persistence of its own: every store under src/shell/ would be a second path", () => {
		const roots = [import.meta.dirname];
		const sources: string[] = [];
		while (roots.length > 0) {
			const dir = roots.pop()!;
			for (const entry of readdirSync(dir, {withFileTypes: true})) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) roots.push(path);
				else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) sources.push(path);
			}
		}
		assert.isAbove(sources.length, 0);

		for (const path of sources) {
			const code = readFileSync(path, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "");
			for (const forbidden of [
				"@demlik/tea/node",
				"@demlik/tea/mem",
				"fileStore",
				"memoryStore",
				"localStorage",
				"indexedDB",
				"node:fs",
				"/durability/",
			]) {
				assert.strictEqual(`${path}: ${code.includes(forbidden)}`, `${path}: false`);
			}
		}
	});
});
