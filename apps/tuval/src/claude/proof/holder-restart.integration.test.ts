/**
 * The restart the real-CLI harness exists to demonstrate, over a row whose layer reads the late
 * holder: boot once against a project dir, open a session, stop, boot again against the same dir.
 *
 * Boot 2 is the whole case. The row is no graph node, so `restore` is what brings it back, and
 * `restore` runs *inside* `boot` — so the holder has to be filled before the boot that reads it
 * returns. A harness that filled it afterwards was one step too late and the row's layer died on
 * an empty holder ([#7976](https://github.com/kamp-us/phoenix/issues/7976)); `boot`'s `onKernel`
 * hook is where the fill sits now, and dropping it from the two calls below is what makes this
 * case red again.
 *
 * It runs on `ScriptedAiAgent.layer` through `./holder-desk.ts`, so it calls no model API and
 * spends nothing (founder ruling on #7582 and #7586). The real CLI is `./serve.ts`, the founder's
 * own local run, and no workflow reaches it.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, type FileSystem, Option, Scope} from "effect";
import type {AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {boot, projectDir} from "../../boot.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import type {ProcessHandle, ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import {handOverKernel} from "./late.ts";
import {HOLDER_PROGRAM, HOLDER_SESSION, PROJECT_ROOT_VAR} from "./names.ts";

const TIMEOUT = 60_000;

const configModule = fileURLToPath(new URL("./holder-desk.ts", import.meta.url));

const tempDirs: string[] = [];

const freshProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-holder-restart-")));
	tempDirs.push(dir);
	mkdirSync(projectDir(dir));
	process.env[PROJECT_ROOT_VAR] = dir;
	return dir;
};

const bootHolder = (project: string) =>
	boot({global: configModule, project, onKernel: handOverKernel});

const sessionOf = (handle: ProcessHandle): AiAgentSessionState =>
	handle.getState() as AiAgentSessionState;

/**
 * The host dispatches a Cmd's follow-up Msgs unawaited (`../../host/actor.ts`), so both the fresh
 * spawn's boot Cmd and the restore's reconnect settle after the call that started them returns.
 */
const settled = Effect.fn("holderRestart.settled")(function* (
	handle: ProcessHandle,
	what: string,
	ready: (state: AiAgentSessionState) => boolean,
) {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const state = sessionOf(handle);
		if (ready(state)) return state;
		yield* Effect.sleep("10 millis");
	}
	return yield* Effect.die(
		new Error(`${what} never settled; last seen ${JSON.stringify(sessionOf(handle))}`),
	);
});

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>) =>
	effect.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

describe("a row whose layer reads the late holder, across a restart", () => {
	it.live(
		"comes back live on the second boot over the same project dir, resuming its own session",
		() =>
			run(
				Effect.gen(function* () {
					const project = freshProject();
					let opened: ProcessId | null = null;

					yield* Effect.scopedWith(
						Effect.fnUntraced(function* (scope) {
							const booted = yield* Scope.provide(bootHolder(project), scope);
							// The picker's path: a process under no node, given the kernel
							// (`../../shell/picker/open.ts`). Spawning is what opens the session (#7925).
							const handle = yield* Context.get(booted.kernel, Processes).spawn(
								ProgramId.make(HOLDER_PROGRAM),
								{services: booted.kernel},
							);
							const ready = yield* settled(
								handle,
								"the first boot's session",
								(state) => state.phase === "ready",
							);
							assert.strictEqual(ready.sessionId, HOLDER_SESSION);
							opened = handle.id;
						}),
					);
					assert.isNotNull(opened, "the first boot never opened a session to checkpoint");

					const booted = yield* bootHolder(project);

					assert.strictEqual(
						booted.report.restoredCount,
						1,
						"the second boot did not bring the checkpointed row back",
					);
					const live = yield* ProcessTable.use((table) => table.list).pipe(
						Effect.provideContext(booted.kernel),
					);
					assert.deepStrictEqual(
						live.map((row) => row.id),
						[opened],
						"the restored process is not in the table under the id it was checkpointed at",
					);

					const handle = yield* Context.get(booted.kernel, Processes)
						.handle(opened as ProcessId)
						.pipe(Effect.map(Option.getOrNull));
					assert.isNotNull(handle, "the restored row has no handle to dispatch into");
					const restored = yield* settled(
						handle as ProcessHandle,
						"the restored session",
						(state) => state.phase === "ready",
					);

					// Ready under the same id is the resume having gone through: `restore` dispatches
					// `reconnect` (`../../durability/resume.ts`), the handler rebuilds this row's layer
					// out of the holder, and the backend answers `start({resume: sessionId})`. A row
					// that merely did not throw would sit at `idle` with its failure set.
					assert.strictEqual(
						restored.sessionId,
						HOLDER_SESSION,
						"the restart opened a new session instead of resuming the checkpointed one",
					);
					assert.isNull(restored.failure, "the restored session came back carrying a failure");
					assert.isAbove(
						restored.connection,
						1,
						"the restored session never stood a second transport up",
					);
				}),
			),
		TIMEOUT,
	);
});

process.on("exit", () => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
