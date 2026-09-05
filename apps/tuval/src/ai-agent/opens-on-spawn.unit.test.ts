/**
 * The fresh arm, end to end on `ScriptedAiAgent`: spawning the row is the whole act (#7925).
 *
 * Nothing here dispatches `start`. What the picker does is `processes.spawn` and then bind a
 * window, so that is all this does — and what it has to show is a session that opened itself and a
 * prompt that was answered rather than refused. The restored arm's counterpart is
 * `restore/restore.unit.test.ts`; the checkpoint rule the two share is `restore/checkpoint.ts`.
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
import type {TranscriptPayload} from "./ports/index.ts";
import {aiAgentProgram} from "./program.ts";
import {plainReply, SESSION_ID} from "./service/fixtures/scripts.ts";
import {ScriptedAiAgent} from "./service/index.ts";

const PROGRAM = "ai-agent-fresh-spawn-test";
const CWD = "/work";

interface Emitted {
	readonly port: string;
	readonly payload: unknown;
}

const wired: ReadonlySet<string> = new Set(Object.values(aiAgentPortNames));

const recorder = (log: Array<Emitted>) =>
	ProcessPorts.of({
		emit: (port, payload) =>
			wired.has(port)
				? Effect.sync(() => {
						log.push({port, payload});
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

const eventually = (check: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 400 && !check(); attempt += 1) yield* Effect.sleep("5 millis");
	});

const sessionOf = (handle: ProcessHandle): AiAgentSessionState => {
	const state = handle.getState();
	assert.isTrue(isAiAgentSessionState(state), "the process is not holding an agent session state");
	return state as AiAgentSessionState;
};

/** Spawn with no checkpoint and no `start`, exactly as `shell/picker/open.ts` does. */
const onAFreshSpawn = <A, E>(
	body: (handle: ProcessHandle, log: ReadonlyArray<Emitted>) => Effect.Effect<A, E>,
) =>
	Effect.gen(function* () {
		const log: Array<Emitted> = [];
		const processes = yield* Processes;
		const handle = yield* processes.spawn(ProgramId.make(PROGRAM), {
			services: Context.make(ProcessPorts, recorder(log)),
		});
		return yield* body(handle, log);
	}).pipe(Effect.scoped, Effect.provide(kernel));

describe("a freshly spawned agent session", () => {
	it.live("opens itself, with no caller dispatching start", () =>
		onAFreshSpawn((handle) =>
			Effect.gen(function* () {
				yield* eventually(() => sessionOf(handle).phase === "ready");
				const session = sessionOf(handle);
				assert.strictEqual(session.phase, "ready", "the spawned session never opened");
				assert.strictEqual(session.sessionId, SESSION_ID);
				assert.strictEqual(session.cwd, CWD);
				assert.isNull(session.failure, "opening the session recorded a refusal");
			}),
		),
	);

	it.live("takes a prompt and puts the reply on the transcript port", () =>
		onAFreshSpawn((handle, log) =>
			Effect.gen(function* () {
				yield* eventually(() => sessionOf(handle).phase === "ready");
				yield* handle.dispatch({type: "prompt", text: "hello", key: "k1"});
				yield* eventually(() => sessionOf(handle).transcript.items.length === 2);

				const session = sessionOf(handle);
				assert.isNull(session.failure, "the first prompt into a fresh session was refused");
				assert.deepStrictEqual(
					session.transcript.items.map((item) => item.id),
					["u1", "a1"],
				);
				const published = [...log]
					.reverse()
					.find((entry) => entry.port === aiAgentPortNames.transcript)?.payload as
					| TranscriptPayload
					| undefined;
				assert.deepStrictEqual(published?.items, session.transcript.items);
			}),
		),
	);
});
