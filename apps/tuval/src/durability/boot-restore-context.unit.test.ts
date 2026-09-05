/**
 * The context `boot.ts` hands `restore`, pinned from `boot` itself rather than from a hand-built
 * kernel. `restore` takes `Context.Context<never>` and accepts whatever it is given, so the
 * guarantee that a restored process gets the whole kernel is positional and the checker has no
 * opinion about it — it has been got wrong twice (#7951, #7976) and nothing failed (#7993).
 *
 * What makes it falsifiable is the config: `config-fixtures/kernel-restore.ts` plans no graph node,
 * so the launcher has nothing to bring back and `restore` is the only route the checkpointed row
 * has. Its handler needs `SpellBridge`, a kernel service outside restore's own four (`Checkpoints`,
 * `Processes`, `ProcessTable`, `Registry`) — narrow the context `boot.ts` restores under and the
 * second boot dies with `Service not found: tuval/SpellBridge`.
 *
 * The narrowing has to be of both routes at once, because `boot.ts` carries the kernel on two:
 * `restore`'s `services` argument, and the ambient `Effect.provideContext(kernel)` around the call.
 * `Effect.provideContext` merges into the fiber's context rather than replacing it
 * (`effect` `src/internal/effect.ts`'s `provideContext`, `updateContext(self, Context.merge(…))`),
 * so a handler that misses the argument still resolves off the ambient and each route masks the
 * other. That a spawner's `services` is a floor rather than the set is #7972's, not this test's.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Option} from "effect";
import {afterEach} from "vitest";
import {boot, coreSpells, projectDir} from "../boot.ts";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {bridgeProbeId} from "../config-fixtures/kernel-restore.ts";
import {Processes} from "../process/Processes.ts";
import type {ProcessId} from "../process/process.ts";

const config = fileURLToPath(new URL("../config-fixtures/kernel-restore.ts", import.meta.url));

const tempDirs: string[] = [];

/** A project dir whose `.tuval/` exists and is empty: no project config, nothing checkpointed yet. */
const freshProject = () => {
	// realpath: macOS resolves /var to /private/var, and the boot reports the dir it is given.
	const project = realpathSync(mkdtempSync(join(tmpdir(), "tuval-restore-context-")));
	tempDirs.push(project);
	mkdirSync(projectDir(project));
	return project;
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const handleOf = (id: ProcessId) =>
	Effect.map(
		Processes.use((processes) => processes.handle(id)),
		Option.getOrThrowWith(() => new Error(`no live handle for process "${id}"`)),
	);

/**
 * The first boot: nothing is planned and nothing is checkpointed, so the probe is spawned the way
 * the picker spawns one — under no node — and marked twice, which is the state the next boot has
 * to find. Its handler is never reached here: `SpawnedProcesses` hands a spawn its ports and
 * nothing else, so `mark` is deliberately a Msg that emits no Cmd.
 */
const firstBoot = (project: string) =>
	Effect.gen(function* () {
		const booted = yield* boot({global: config, project});
		const id = yield* SpawnedProcesses.use((spawned) =>
			spawned.spawn(bridgeProbeId, Option.none()),
		).pipe(Effect.provideContext(booted.kernel));
		const handle = yield* handleOf(id).pipe(Effect.provideContext(booted.kernel));
		yield* handle.dispatch({type: "mark"});
		yield* handle.dispatch({type: "mark"});
		return {id, report: booted.report, state: handle.getState()};
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer), Effect.orDie);

/**
 * The second boot over the same state dir: `restore` spawns the probe back and dispatches the row's
 * own `resume`, whose Cmd handler asks the kernel for `SpellBridge`. `handle.dispatch` runs to idle,
 * so the follow-up is folded into the state before `boot` returns.
 */
const secondBoot = (project: string, id: ProcessId) =>
	Effect.gen(function* () {
		const booted = yield* boot({global: config, project});
		const handle = yield* handleOf(id).pipe(Effect.provideContext(booted.kernel));
		return {report: booted.report, state: handle.getState()};
	}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer), Effect.orDie);

describe("the kernel context boot hands restore", () => {
	it.effect("a restored process the graph never planned resumes on the whole kernel", () =>
		Effect.gen(function* () {
			const project = freshProject();

			const first = yield* firstBoot(project);
			// Nothing was planned and nothing was checkpointed, so neither spawner brought anything
			// back — the row below is the only thing the second boot can restore.
			assert.strictEqual(first.report.processCount, 0);
			assert.strictEqual(first.report.restoredCount, 0);
			assert.deepStrictEqual(first.state, {marks: 2, spells: 0});

			const second = yield* secondBoot(project, first.id);

			// One process back, and `restore` is what brought it: the graph plans no node, so the
			// launcher had nothing to spawn at all.
			assert.strictEqual(second.report.processCount, 1);
			assert.strictEqual(second.report.restoredCount, 1);
			// A boot registering no core spell would make the `spells` row below read 0 either way,
			// which is the reading that would pass with the bridge never resolved.
			assert.isAbove(coreSpells.length, 0);
			// `marks` is the checkpointed state coming back; `spells` is the resume's handler having
			// resolved `SpellBridge` out of the context `boot.ts` restored under.
			assert.deepStrictEqual(second.state, {marks: 2, spells: coreSpells.length});
		}),
	);
});
