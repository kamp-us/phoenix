/**
 * A row that names no folder takes each session's folder when the session starts (#9694, ruling
 * #9668 R3.1): the folder its spawner runs in, `WorkingFolder`. From then on the folder is the
 * session's own: a process brought back from its checkpoint under a spawner in another folder comes
 * back in the folder it started in.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {NodeId} from "../ports/graph.ts";
import {ProcessPorts, unwired} from "../ports/index.ts";
import {Processes} from "../process/Processes.ts";
import type {ProcessHandle} from "../process/process.ts";
import {WorkingFolder} from "../process/working-folder.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {type AiAgentSessionState, isAiAgentSessionState} from "./core/index.ts";
import {aiAgentProgram} from "./program.ts";
import {plainReply} from "./service/fixtures/scripts.ts";
import {ScriptedAiAgent} from "./service/index.ts";

const PROGRAM = "ai-agent-folder-at-start-test";
const FIXED = "ai-agent-fixed-folder-test";

const atStart = aiAgentProgram({id: PROGRAM, layer: ScriptedAiAgent.layer(plainReply), config: {}});
const fixed = aiAgentProgram({
	id: FIXED,
	layer: ScriptedAiAgent.layer(plainReply),
	config: {cwd: "/row/own"},
});

const kernel = Processes.layer.pipe(
	Layer.provideMerge(Checkpoints.layer(memoryStores())),
	Layer.provideMerge(Layer.orDie(Registry.layer([atStart, fixed]))),
);

const eventually = (what: string, check: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 400 && !check(); attempt += 1) yield* Effect.sleep("5 millis");
		assert.isTrue(check(), `timed out after 2s waiting for ${what}`);
	});

const sessionOf = (handle: ProcessHandle): AiAgentSessionState => {
	const state = handle.getState();
	assert.isTrue(isAiAgentSessionState(state), "the process is not holding an agent session state");
	return state as AiAgentSessionState;
};

const ports = Context.make(ProcessPorts, unwired(NodeId.make("test")));

/** A spawn set carrying `folder` as the spawner's, or none at all. */
const servicesIn = (folder: string | null): Context.Context<never> =>
	folder === null ? ports : Context.add(ports, WorkingFolder, {path: folder});

const started = (handle: ProcessHandle) =>
	eventually("the session to start", () => {
		const session = sessionOf(handle);
		return session.sessionId !== null || session.failure !== null;
	});

describe("a row that takes its folder at start", () => {
	it("says so on the row, and a row that fixes its folder does not", () => {
		assert.strictEqual(atStart.folderAtStart, true);
		assert.isUndefined(fixed.folderAtStart);
	});

	it.live("starts its session in the folder its spawner runs in", () =>
		Effect.gen(function* () {
			const processes = yield* Processes;
			const handle = yield* processes.spawn(ProgramId.make(PROGRAM), {
				services: servicesIn("/projects/phoenix"),
			});
			yield* started(handle);
			const session = sessionOf(handle);
			assert.isNull(session.failure);
			assert.strictEqual(session.cwd, "/projects/phoenix");
		}).pipe(Effect.scoped, Effect.provide(kernel)),
	);

	it.live("keeps the folder it started in when it comes back under another spawner", () =>
		Effect.gen(function* () {
			const processes = yield* Processes;
			const first = yield* processes.spawn(ProgramId.make(PROGRAM), {
				services: servicesIn("/projects/phoenix"),
			});
			yield* started(first);
			yield* processes.stop(first.id);
			const back = yield* processes.spawn(ProgramId.make(PROGRAM), {
				id: first.id,
				services: servicesIn("/projects/elsewhere"),
			});
			assert.strictEqual(sessionOf(back).cwd, "/projects/phoenix");
		}).pipe(Effect.scoped, Effect.provide(kernel)),
	);

	it.live("refuses to start when nothing names a folder, rather than guessing one", () =>
		Effect.gen(function* () {
			const processes = yield* Processes;
			const handle = yield* processes.spawn(ProgramId.make(PROGRAM), {services: servicesIn(null)});
			yield* started(handle);
			const session = sessionOf(handle);
			assert.strictEqual(session.failure?.reason, "no-folder");
			assert.isNull(session.sessionId);
		}).pipe(Effect.scoped, Effect.provide(kernel)),
	);

	it.live("leaves a row that fixes its folder in that folder, whatever its spawner runs in", () =>
		Effect.gen(function* () {
			const processes = yield* Processes;
			const handle = yield* processes.spawn(ProgramId.make(FIXED), {
				services: servicesIn("/projects/phoenix"),
			});
			yield* started(handle);
			assert.strictEqual(sessionOf(handle).cwd, "/row/own");
		}).pipe(Effect.scoped, Effect.provide(kernel)),
	);
});
