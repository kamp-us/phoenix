/**
 * The AI-agent program filling the kernel's two generic out-ports, on a real spawn (#8722).
 *
 * The assertion is on what crossed `title@1` and `status@1`, never on a projection read back out
 * of the process: the whole point of R8.1 is that a board reads a line off the port and knows
 * nothing about agents, so a test reading anything else would pass over a program that publishes
 * nothing.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {NodeId} from "../ports/graph.ts";
import {PortNotWired, ProcessPorts} from "../ports/index.ts";
import {Processes} from "../process/Processes.ts";
import type {ProcessHandle} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {type AiAgentSessionState, isAiAgentSessionState} from "./core/index.ts";
import {aiAgentPortNames} from "./handlers/index.ts";
import {aiAgentProgram} from "./program.ts";
import {models, plainReply} from "./service/fixtures/scripts.ts";
import {ScriptedAiAgent} from "./service/index.ts";

const PROGRAM = "ai-agent-self-report-test";
const CWD = "/Users/kim/code/phoenix";

const wired: ReadonlySet<string> = new Set(Object.values(aiAgentPortNames));

const recorder = (log: Array<readonly [port: string, line: unknown]>) =>
	ProcessPorts.of({
		emit: (port, payload) =>
			wired.has(port)
				? Effect.sync(() => {
						log.push([port, payload]);
						return [];
					})
				: Effect.fail(new PortNotWired({node: NodeId.make("test"), port})),
	});

const row = aiAgentProgram({
	id: PROGRAM,
	layer: ScriptedAiAgent.layer(plainReply),
	config: {cwd: CWD},
});

const kernel = Processes.layer.pipe(
	Layer.provideMerge(Checkpoints.layer(memoryStores())),
	Layer.provideMerge(Registry.layer([row])),
);

/** A spent budget asserts rather than falling through, so a timeout names itself (#7925). */
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

type Log = ReadonlyArray<readonly [port: string, line: unknown]>;

const linesOn = (log: Log, port: string): ReadonlyArray<string> =>
	log.filter(([on]) => on === port).map(([, line]) => line as string);

const newestOn = (log: Log, port: string): string | undefined => linesOn(log, port).at(-1);

const onASpawn = <A, E>(body: (handle: ProcessHandle, log: Log) => Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const log: Array<readonly [string, unknown]> = [];
		const processes = yield* Processes;
		const handle = yield* processes.spawn(ProgramId.make(PROGRAM), {
			services: Context.make(ProcessPorts, recorder(log)),
		});
		return yield* body(handle, log);
	}).pipe(Effect.scoped, Effect.provide(kernel));

const ready = (handle: ProcessHandle) =>
	eventually("the spawned session to reach ready", () => sessionOf(handle).phase === "ready");

describe("an AI-agent process on the kernel's generic out-ports", () => {
	it.live("publishes a title of program, model and folder once the session is up", () =>
		onASpawn((handle, log) =>
			Effect.gen(function* () {
				yield* ready(handle);
				yield* eventually(
					"the title to name the model the layer reported",
					() => newestOn(log, aiAgentPortNames.title)?.includes(models.current.name) === true,
				);
				assert.strictEqual(
					newestOn(log, aiAgentPortNames.title),
					`${PROGRAM} · ${models.current.name} · phoenix`,
				);
			}),
		),
	);

	it.live("re-publishes the title with the new model when the session is switched", () =>
		onASpawn((handle, log) =>
			Effect.gen(function* () {
				yield* ready(handle);
				const other = models.available.find((model) => model.id !== models.current.id);
				assert.isDefined(other);
				yield* handle.dispatch({type: "setModel", model: other!});
				yield* eventually(
					"the title to name the model just switched to",
					() => newestOn(log, aiAgentPortNames.title)?.includes(other!.name) === true,
				);
				assert.strictEqual(
					newestOn(log, aiAgentPortNames.title),
					`${PROGRAM} · ${other!.name} · phoenix`,
				);
			}),
		),
	);

	it.live("publishes the session's last line and its cost on the status port", () =>
		onASpawn((handle, log) =>
			Effect.gen(function* () {
				yield* ready(handle);
				yield* handle.dispatch({type: "prompt", text: "hello", key: "k1", timestamp: Date.now()});
				yield* eventually(
					"the reply to reach the status port",
					() => newestOn(log, aiAgentPortNames.status)?.startsWith("hi back") === true,
				);
				assert.strictEqual(newestOn(log, aiAgentPortNames.status), "hi back · $0.00");
			}),
		),
	);
});
