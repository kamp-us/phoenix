/**
 * The parent edge a kernel-tool `spawn` carries, on a real kernel (#8758).
 *
 * The whole chain is the real one — `SpawnedProcesses` over `Processes`, the real `process` spells
 * in a `SpellRegistry`, the real `SpellExecutor` and the real `SpellBridge` — because the claim is
 * about what survives the wire. `SpellBridge.call` puts only the caller's window on it and the
 * executor re-resolves the process from that window through `WindowIndex` (#7617 R2.2), so a test
 * that handed the executor a scope directly would prove nothing about the route a tool call takes.
 *
 * The one double is the index, which stands in for the desk: a window bound to the calling process
 * is exactly what `shellWindowIndexKernel` reads off live shell state, and there is no shell here.
 *
 * The row's own scope names no window on purpose — it is the value `.tuval/tuval.config.ts` writes
 * down, four plain ids, because a config module is evaluated before any window exists. The window
 * arrives as `CallingWindow`, the service `shell/picker/open.ts` adds at the spawn, which is what
 * this file exists to prove reaches the bridge: the pair of cases below is the same call with the
 * service and without it.
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
import {ProcessTable} from "../../process/ProcessTable.ts";
import type {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {KernelBridge} from "./KernelBridge.ts";

const callerId = ProgramId.make("kernel-tool-caller");
const childId = ProgramId.make("kernel-tool-child");

/** Two inert rows: what a `spawn` produces is a table entry, and neither row has to do anything. */
const caller = defineProgram({id: callerId, init: () => ({}), update: {}});
const child = defineProgram({id: childId, init: () => ({}), update: {}});

const workspace = WorkspaceId.make("ws-1");
const window = WindowId.make("window-1");
/** The row's scope as a config module writes it: a workspace and a client, and no window. */
const rowScope: SpellScope = {workspace, client: ClientId.make("tuval-desk")};

const kernel = SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
	Layer.provideMerge(Processes.layer),
	Layer.provideMerge(
		Layer.mergeAll(Registry.layer([caller, child]), Checkpoints.layer(memoryStores())),
	),
);

/** The desk's answer for the one window under test: it shows `process`, in this workspace. */
const indexShowing = (process: ProcessId) =>
	Layer.succeed(
		WindowIndex,
		WindowIndex.of({
			resolve: (asked) =>
				asked === window
					? Effect.succeed({process, workspace})
					: Effect.fail(new NoSuchWindow({window: asked})),
		}),
	);

const spells = SpellRegistry.scripted(processSpells);

const bridgeOver = (process: ProcessId) =>
	SpellBridge.layer({allow: everyRegistered}).pipe(
		Layer.provide(
			Layer.mergeAll(
				spells,
				SpellExecutor.layer.pipe(Layer.provide(Layer.mergeAll(spells, indexShowing(process)))),
			),
		),
	);

/**
 * Spawn the caller as a root, drive a tool `spawn` through the real bridge, and answer with the
 * parent the process table recorded for the child. `opened` is the window the spawner named, or
 * none — the one difference between the two cases below.
 *
 * The spell's own requirements are erased by the registry and owed at the call
 * (`../../commands/executor.ts`), so `SpawnedProcesses` reaches it from the ambient context this
 * whole effect runs under rather than from anything the bridge closed over.
 */
const parentRecordedFor = (opened: Option.Option<WindowId>) =>
	Effect.gen(function* () {
		const spawned = yield* SpawnedProcesses;
		const callerProcess = yield* spawned.spawn(callerId, Option.none());

		const withWindow = <A, E, R>(build: Effect.Effect<A, E, R>) =>
			Option.isNone(opened)
				? build
				: Effect.provideService(build, CallingWindow, {window: opened.value});
		const built = yield* withWindow(
			Layer.build(KernelBridge.live(rowScope)).pipe(Effect.provide(bridgeOver(callerProcess))),
		);
		const tools = Context.get(built, KernelBridge);

		const childProcess = yield* tools.spawn(childId);
		const row = yield* ProcessTable.use((table) => table.get(childProcess));
		return {callerProcess, parentId: row.parentId};
	}).pipe(Effect.provide(kernel), Effect.scoped, Effect.orDie);

describe("a spawn issued through an agent row's kernel tool", () => {
	it.effect("is a child of the process the calling window shows", () =>
		Effect.gen(function* () {
			const {callerProcess, parentId} = yield* parentRecordedFor(Option.some(window));

			assert.deepStrictEqual(
				parentId,
				Option.some(callerProcess),
				"the window reached the bridge, so the executor resolved the caller as the parent",
			);
		}),
	);

	it.effect("is a root when the spawner named no window, as a row's own scope names none", () =>
		Effect.gen(function* () {
			const {parentId} = yield* parentRecordedFor(Option.none());

			assert.deepStrictEqual(parentId, Option.none());
		}),
	);
});
