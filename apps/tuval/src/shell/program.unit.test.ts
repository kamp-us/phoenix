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
import {Context, Effect, Layer, Option, Result} from "effect";
import {afterAll} from "vitest";
import {boot, projectDir} from "../boot.ts";
import {reboundTable} from "../config-fixtures/shell-rebound-keys.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {SnapshotRefused} from "../durability/errors.ts";
import {memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {ProcessId} from "../process/process.ts";
import type {AnyProgram} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {applyMsg, initialState, type ShellMsg} from "./core/index.ts";
import type {ServeDeskOptions} from "./host/index.ts";
import {applyKeysConfig, defaultPrefixTable} from "./keys/index.ts";
import {showsInAWindow} from "./picker/entries.ts";
import {
	SHELL_VERSION,
	shellId,
	shellNode,
	shellPrefixTable,
	shellProgram,
	shellStateOf,
	unwiredShellEffects,
	windowBindings,
} from "./program.ts";
import {WindowId} from "./window/index.ts";

/** The box's own config module — the user-owned surface the shell is registered through. */
const boxConfig = fileURLToPath(new URL("../../.tuval/tuval.config.ts", import.meta.url));

/** A config layer whose shell row is built on a rebound prefix, for the #7890 walk below. */
const reboundConfig = fileURLToPath(
	new URL("../config-fixtures/shell-rebound-keys.ts", import.meta.url),
);

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

/**
 * Vitest's 5000 ms default did not cover this file even on an idle machine (#8209): the first case
 * boots the real box config, which reads and dynamically imports `.tuval/tuval.config.ts` and starts
 * a kernel over a fresh temp dir. Under the parallel local lanes of #8119 the rest went with it, so
 * every case states the same budget rather than each guessing its own.
 */
const BUDGET_MS = 20_000;

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
	it.effect(
		"is registered through the user-owned config module and spawns as a lone root",
		() =>
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
		BUDGET_MS,
	);

	it(
		"declares no port, requests no capability, is headless and is placed where the kernel runs",
		() => {
			const shell = row();
			assert.deepStrictEqual(shell.ports, {});
			assert.deepStrictEqual(shell.capabilities, []);
			// The desk is not a window it can be opened inside (#7946).
			assert.isUndefined(shell.renderer);
			assert.isFalse(showsInAWindow(shell));
			// The kernel's word for the Node host is `local`; there is no `node` arm on `Placement`.
			assert.deepStrictEqual(shell.placement, {host: "local"});
			assert.strictEqual(shell.identity.version, SHELL_VERSION);
		},
		BUDGET_MS,
	);

	it.effect(
		"brings workspaces, layouts, focus and per-window view state back byte-equal",
		() => {
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
		},
		BUDGET_MS,
	);

	it(
		"keeps a restored window whose process id no longer resolves, pointing at ProcessGone",
		() => {
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
		},
		BUDGET_MS,
	);

	it(
		"answers Empty for a window with no process, so the surface shows the picker",
		() => {
			const bindings = windowBindings(initialState(), new Set());
			assert.deepStrictEqual([...bindings.values()], [{_tag: "Empty"}]);
		},
		BUDGET_MS,
	);

	it(
		"refuses a version-matched snapshot whose interior is the wrong shape",
		() => {
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
		},
		BUDGET_MS,
	);

	it.effect(
		"refuses a snapshot from another definition and never fresh-boots over it",
		() => {
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
		},
		BUDGET_MS,
	);

	it(
		"holds no persistence of its own: every store under src/shell/ would be a second path",
		() => {
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
		},
		BUDGET_MS,
	);
});

/**
 * The kernel's key grammar has one namer on the boot path (#7890). The shell row publishes the
 * table it resolved, `boot` reports it, and `src/bin.ts` hands that value — never a default of its
 * own — to `serveDesk`, whose `table` is what every attached page is sent (ADR 0353). The
 * socket-level half of that walk belongs to `./transport/transport.integration.test.ts`; what these
 * cases hold is the value the bin passes it.
 */
describe("the boot path's one prefix table", () => {
	it(
		"reads a shell row's own table back off the row, and the default when a config names none",
		() => {
			const rebound = Result.getOrThrow(applyKeysConfig(defaultPrefixTable, {prefix: "<c-a>"}));
			assert.deepStrictEqual(
				shellPrefixTable([shellProgram({table: rebound, effects: unwiredShellEffects})]),
				rebound,
			);
			assert.deepStrictEqual(shellPrefixTable([row()]), defaultPrefixTable);
			assert.deepStrictEqual(shellPrefixTable([]), defaultPrefixTable);
		},
		BUDGET_MS,
	);

	it.effect(
		"carries a config-set table through to the value the bin hands `serveDesk`",
		() =>
			Effect.gen(function* () {
				const booted = yield* boot({global: reboundConfig, project: freshProject()});
				// The one expression `src/bin.ts` builds around the reported table.
				const options = {
					kernel: booted.kernel,
					port: 0,
					table: booted.keyTable,
				} satisfies ServeDeskOptions;
				assert.deepStrictEqual(options.table, reboundTable);
				assert.notDeepEqual(options.table, defaultPrefixTable);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		BUDGET_MS,
	);

	it.effect(
		"leaves a config that names no table on the default, on both sides",
		() =>
			Effect.gen(function* () {
				const booted = yield* boot({global: boxConfig, project: freshProject()});
				assert.deepStrictEqual(booted.keyTable, defaultPrefixTable);
				assert.deepStrictEqual(shellPrefixTable([row()]), booted.keyTable);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		BUDGET_MS,
	);
});
