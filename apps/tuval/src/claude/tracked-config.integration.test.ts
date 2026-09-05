/**
 * The tracked config's Claude row, booted: `../../.tuval/tuval.config.ts` is the module under test,
 * not a fixture written for it (#7958). What it proves is that the row a user's own config can
 * write registers, shows in the picker, and that the kernel it is spawned into holds the
 * `SpellBridge` the row leaves open — and that a `spawn` through `KernelBridge` on that bridge
 * starts a process the process table shows.
 *
 * **It never spawns the `claude-session` process itself.** A fresh spawn emits the `aiAgent.boot`
 * Cmd (`../ai-agent/core/machine.ts`), which opens the session, which runs the real `claude` CLI on
 * whoever's login is present — the founder's alone (founder ruling on #7582 and #7586). So the row
 * is read out of the registry, and the kernel tools are driven the way the row drives them: over
 * the config's own `claudeSessionScope`, so a scope this test invented could not pass.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {afterAll} from "vitest";
import {claudeSessionScope} from "../../.tuval/tuval.config.ts";
import {boot, projectDir} from "../boot.ts";
import {SpellBridge} from "../commands/bridge/index.ts";
import {counterId} from "../demo/counter.ts";
import {PI_SESSION_PROGRAM} from "../pi/renderer-ref.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {programEntries} from "../shell/picker/entries.ts";
import {CLAUDE_SESSION_PROGRAM} from "./renderer-ref.ts";
import {KernelBridge} from "./tools/index.ts";

const configModule = fileURLToPath(new URL("../../.tuval/tuval.config.ts", import.meta.url));

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const freshProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-tracked-config-")));
	tempDirs.push(dir);
	mkdirSync(projectDir(dir));
	return dir;
};

/**
 * The tracked config booted as the global layer over an empty project, so the checkpoints and the
 * state dir are the temp root's and this repo's own `.tuval/` is read but never written.
 */
const bootTracked = Effect.fn("trackedConfig.boot")(function* () {
	return yield* boot({global: configModule, project: freshProject()});
});

describe("the Claude row the tracked config registers", () => {
	it.effect(
		"is in the registry and in the picker, beside pi-session",
		() =>
			Effect.gen(function* () {
				const booted = yield* bootTracked();
				const rows = yield* Registry.pipe(
					Effect.flatMap((registry) => registry.list),
					Effect.provideContext(booted.kernel),
				);
				const offered = programEntries(rows).map((entry) => entry.programId);
				assert.include(
					offered,
					ProgramId.make(CLAUDE_SESSION_PROGRAM),
					"a row the picker leaves out is a Claude window nobody can open",
				);
				assert.include(offered, ProgramId.make(PI_SESSION_PROGRAM));
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		{timeout: 60_000},
	);

	it.effect(
		"leaves SpellBridge open and is spawned into a kernel that holds one",
		() =>
			Effect.gen(function* () {
				const booted = yield* bootTracked();
				assert.isDefined(
					Context.get(booted.kernel, SpellBridge),
					"the row's layer asks for SpellBridge at spawn; a kernel without one dies at the first tool call",
				);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		{timeout: 60_000},
	);

	it.effect(
		"reaches the real kernel through its tools: a KernelBridge spawn shows in the process table",
		() =>
			Effect.gen(function* () {
				const booted = yield* bootTracked();
				const bridge = yield* Layer.build(KernelBridge.live(claudeSessionScope)).pipe(
					Effect.map((built) => Context.get(built, KernelBridge)),
					Effect.provideContext(booted.kernel),
				);

				const spawned = yield* bridge.spawn(counterId).pipe(Effect.provideContext(booted.kernel));
				const row = yield* ProcessTable.pipe(
					Effect.flatMap((table) => table.get(spawned)),
					Effect.provideContext(booted.kernel),
				);
				assert.strictEqual(row.programId, counterId);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		{timeout: 60_000},
	);
});
