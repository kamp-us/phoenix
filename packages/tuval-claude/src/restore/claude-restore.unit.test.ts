/**
 * Claude restore on the generic rules, at the row: what the reconnect handler builds and calls, and
 * what a refused resume ends as. The checkpoint's field set, the rehydrating `init` and the
 * reconnect Msg's Cmds are the SDK's own and are proven in `@kampus/tuval-sdk`'s
 * `ai-agent/restore/checkpoint.unit.test.ts` and `ai-agent/core/machine.unit.test.ts`.
 *
 * The layer under the row is `ScriptedAiAgent` wrapped in a recorder, because the fact under test is
 * the `start` call the handler makes, and none of that is the Agent SDK's. The whole app doing this
 * over a real `fileStore` is `claude-restore-proof.unit.test.ts`.
 */

import {assert, describe, it} from "@effect/vitest";
import {
	type AiAgentSessionState,
	isAiAgentSessionState,
} from "@kampus/tuval-sdk/kernel/ai-agent/core/index";
import {
	type AgentScript,
	ScriptedAiAgent,
	StartError,
	type StartOptions,
	TuvalAiAgent,
} from "@kampus/tuval-sdk/kernel/ai-agent/service/index";
import {Checkpoints} from "@kampus/tuval-sdk/kernel/durability/Checkpoints";
import {memoryStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {NodeId} from "@kampus/tuval-sdk/kernel/ports/graph";
import {PortNotWired, ProcessPorts} from "@kampus/tuval-sdk/kernel/ports/index";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import type {ProcessHandle} from "@kampus/tuval-sdk/kernel/process/process";
import {Registry} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {Context, Effect, Layer} from "effect";
import {claudeSession} from "../program.ts";

const CWD = "/work";
const SESSION = "claude-restore-unit";

const script: AgentScript = {
	sessionId: SESSION,
	history: [],
	modes: {current: null, available: []},
	models: {current: null, available: []},
	thinking: {current: null, available: []},
	interrupt: [],
	turns: [],
};

interface Recorder {
	/** Every `start` the handlers made, in order: the whole evidence a reconnect resumes by id. */
	readonly starts: Array<StartOptions>;
	/** How many times the row built its layer. A restored process must build none until it reconnects. */
	builds: number;
}

const recorderOf = (): Recorder => ({starts: [], builds: 0});

/**
 * `ScriptedAiAgent.layer` with its builds and its `start` arguments recorded. `refuseResume` is the
 * one behaviour the script cannot produce on demand: it holds one session id, so a refusal would
 * need a second fixture to name an id it does not hold.
 */
const recording = (probe: Recorder, refuseResume = false): Layer.Layer<TuvalAiAgent> =>
	Layer.effect(
		TuvalAiAgent,
		Effect.gen(function* () {
			probe.builds += 1;
			const agent = Context.get(yield* Layer.build(ScriptedAiAgent.layer(script)), TuvalAiAgent);
			return {
				...agent,
				start: (options: StartOptions) => {
					probe.starts.push(options);
					return refuseResume && options.resume !== undefined
						? Effect.fail(
								new StartError({
									reason: "session-not-found",
									cwd: options.cwd,
									detail: `this backend no longer holds session ${options.resume}`,
								}),
							)
						: agent.start(options);
				},
			};
		}),
	);

/** A `ProcessPorts` that is wired to nothing, which the publisher swallows as it does in production. */
const noPorts = ProcessPorts.of({
	emit: (port) => Effect.fail(new PortNotWired({node: NodeId.make("test"), port})),
});

const row = (probe: Recorder, refuseResume = false) =>
	claudeSession({cwd: CWD, layer: recording(probe, refuseResume)});

const withKernel = <A, E>(
	probe: Recorder,
	body: (handle: ProcessHandle) => Effect.Effect<A, E>,
	refuseResume = false,
) => {
	const declared = row(probe, refuseResume);
	return Effect.gen(function* () {
		const processes = yield* Processes;
		const handle = yield* processes.spawn(declared.id, {
			services: Context.make(ProcessPorts, noPorts),
		});
		return yield* body(handle);
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Processes.layer.pipe(
				Layer.provideMerge(Checkpoints.layer(memoryStores())),
				Layer.provideMerge(Registry.layer([declared])),
			),
		),
	);
};

const eventually = (check: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 400 && !check(); attempt += 1) yield* Effect.sleep("5 millis");
	});

const sessionOf = (handle: ProcessHandle): AiAgentSessionState => {
	const state = handle.getState();
	assert.isTrue(isAiAgentSessionState(state), "the process holds no ai-agent-session state");
	return state as AiAgentSessionState;
};

describe("the reconnect handler", () => {
	it.live("rebuilds the layer and calls start with the cwd and the session id", () => {
		const probe = recorderOf();
		return withKernel(probe, (handle) =>
			Effect.gen(function* () {
				yield* eventually(() => sessionOf(handle).phase === "ready");
				assert.deepStrictEqual(probe.starts, [{cwd: CWD}], "the fresh open resumed something");
				assert.strictEqual(probe.builds, 1);

				yield* handle.dispatch({type: "reconnect"});
				yield* eventually(() => probe.starts.length === 2);
				// `holdsTranscript` rides every reconnect since #8369: the process came back with its
				// committed tail, so a layer that can replay history is told not to. The tail itself
				// rides with it, and this session was checkpointed with none.
				assert.deepStrictEqual(probe.starts[1], {
					cwd: CWD,
					resume: {sessionId: SESSION, holdsTranscript: true, held: []},
				});
				assert.strictEqual(probe.builds, 2, "the reconnect reused the handle the stop killed");
			}),
		);
	});

	it.live("ends in gone with SessionNotFound when the backend refuses the resume", () => {
		const probe = recorderOf();
		return withKernel(
			probe,
			(handle) =>
				Effect.gen(function* () {
					yield* eventually(() => sessionOf(handle).phase === "ready");
					yield* handle.dispatch({type: "reconnect"});
					yield* eventually(() => sessionOf(handle).phase === "gone");
					const state = sessionOf(handle);
					assert.strictEqual(state.phase, "gone", "a refused resume left the session reopenable");
					assert.strictEqual(state.failure?.tag, "tuval/ai-agent/StartError");
					assert.strictEqual(
						state.failure?.reason,
						"session-not-found",
						"a refused resume was reported as something a retry could fix",
					);
				}),
			true,
		);
	});
});
