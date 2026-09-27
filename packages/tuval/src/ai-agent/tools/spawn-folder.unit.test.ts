/**
 * The folder a kernel-tool `spawn` starts its child in, on a real kernel (#9694, #9898).
 *
 * The chain is the one `./spawn-parentage.unit.test.ts` stands up — `SpawnedProcesses` over
 * `Processes`, the real `process` spells, `SpellExecutor` and `SpellBridge` — because the spell runs
 * under the kernel's context, not the caller's, and only the real route shows which folder wins.
 * The kernel here carries a home folder, as boot's does, so a child that landed in it would be
 * told apart from one that landed in the caller's.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option} from "effect";
import {defineProgram} from "../../authoring/define-program.ts";
import {everyRegistered, SpellBridge} from "../../commands/bridge/index.ts";
import {processSpells, SpawnedProcesses} from "../../commands/core/process.ts";
import {NoSuchWindow} from "../../commands/errors.ts";
import {SpellExecutor} from "../../commands/executor.ts";
import {SpellRegistry} from "../../commands/registry.ts";
import {CallingWindow, WindowIndex} from "../../commands/scope.ts";
import {ClientId, type Scope as SpellScope, WindowId, WorkspaceId} from "../../commands/spell.ts";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {memoryStores} from "../../durability/stores.ts";
import {Processes} from "../../process/Processes.ts";
import type {ProcessId} from "../../process/process.ts";
import {ProcessFolders, WorkingFolder} from "../../process/working-folder.ts";
import {ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {KernelBridge} from "./KernelBridge.ts";

const callerId = ProgramId.make("kernel-tool-caller");
const childId = ProgramId.make("kernel-tool-child");
const caller = defineProgram({id: callerId, init: () => ({}), update: {}});
const child = defineProgram({id: childId, init: () => ({}), update: {}});

const HOME = "/home/desk";
const PROJECT = "/projects/phoenix";

const workspace = WorkspaceId.make("ws-1");
const window = WindowId.make("window-1");
const rowScope: SpellScope = {workspace, client: ClientId.make("tuval-desk")};

const kernel = SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
	Layer.provideMerge(Processes.layer),
	Layer.provideMerge(
		Layer.mergeAll(Registry.layer([caller, child]), Checkpoints.layer(memoryStores())),
	),
);

const spells = SpellRegistry.scripted(processSpells);

const bridgeOver = (process: ProcessId) =>
	SpellBridge.layer({allow: everyRegistered}).pipe(
		Layer.provide(
			Layer.mergeAll(
				spells,
				SpellExecutor.layer.pipe(
					Layer.provide(
						Layer.mergeAll(
							spells,
							Layer.succeed(
								WindowIndex,
								WindowIndex.of({
									resolve: (asked) =>
										asked === window
											? Effect.succeed({process, workspace})
											: Effect.fail(new NoSuchWindow({window: asked})),
								}),
							),
						),
					),
				),
			),
		),
	);

/**
 * Start the caller in `callerFolder` (or with no folder), have it spawn through its kernel tool,
 * and answer with the folder the child's spawn set carries. Everything runs over a kernel whose own
 * folder is `HOME`.
 */
const childFolderFor = (callerFolder: Option.Option<string>) =>
	Effect.gen(function* () {
		const spawned = yield* SpawnedProcesses;
		const start = spawned.spawn(callerId, Option.none());
		const callerProcess = yield* Option.isNone(callerFolder)
			? start
			: Effect.provideService(start, WorkingFolder, {path: callerFolder.value});

		const built = yield* Layer.build(KernelBridge.live(rowScope)).pipe(
			Effect.provide(bridgeOver(callerProcess)),
			Effect.provideService(CallingWindow, {window}),
		);
		const childProcess = yield* Context.get(built, KernelBridge).spawn(childId);
		const folder = yield* ProcessFolders.use((folders) => folders.folderOf(childProcess));
		return Option.map(folder, (held) => held.path);
	}).pipe(
		Effect.provideService(WorkingFolder, {path: HOME}),
		Effect.provide(kernel),
		Effect.scoped,
		Effect.orDie,
	);

describe("a spawn issued through an agent row's kernel tool", () => {
	it.effect("starts the child in the calling session's folder, not the kernel's home one", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* childFolderFor(Option.some(PROJECT)), Option.some(PROJECT));
		}),
	);

	it.effect("leaves the child in the kernel's folder when the caller carries none", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* childFolderFor(Option.none()), Option.some(HOME));
		}),
	);
});
