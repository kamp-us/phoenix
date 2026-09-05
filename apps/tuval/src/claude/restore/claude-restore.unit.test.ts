/**
 * Claude restore on the generic rules: what the checkpoint is made of, what a restored process does
 * before anything reconnects it, and what a refused resume ends as.
 *
 * The layer under the row is `ScriptedAiAgent` wrapped in a recorder, because the fact under test is
 * the round trip — a restored state, the resume rule's Msg, the Cmd it emits, and the `start` call
 * the handler makes — and none of that is the Agent SDK's. The whole app doing this over a real
 * `fileStore` is `claude-restore-proof.unit.test.ts`.
 */

import {applyCellChecked} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {expect} from "vitest";
import {
	type AiAgentSessionCmd,
	type AiAgentSessionMsg,
	type AiAgentSessionState,
	aiAgentSessionMachine,
	initialState,
	isAiAgentSessionState,
} from "../../ai-agent/core/index.ts";
import {checkpointFields, resumeMessages} from "../../ai-agent/restore/index.ts";
import {
	type AgentScript,
	ScriptedAiAgent,
	StartError,
	type StartOptions,
	TuvalAiAgent,
} from "../../ai-agent/service/index.ts";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {memoryStores} from "../../durability/stores.ts";
import {NodeId} from "../../ports/graph.ts";
import {PortNotWired, ProcessPorts} from "../../ports/index.ts";
import {Processes} from "../../process/Processes.ts";
import type {ProcessHandle} from "../../process/process.ts";
import {Registry} from "../../registry/Registry.ts";
import {claudeSession} from "../program.ts";

const CWD = "/work";
const SESSION = "claude-restore-unit";

const script: AgentScript = {
	sessionId: SESSION,
	history: [],
	modes: {current: null, available: []},
	models: {current: null, available: []},
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

const machine = aiAgentSessionMachine({cwd: CWD});

const apply = (
	state: AiAgentSessionState,
	msg: AiAgentSessionMsg,
): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(machine, state, msg);

/** A checkpoint as the store would hand one back: a session that was live when the app stopped. */
const saved: AiAgentSessionState = {
	...initialState(CWD),
	phase: "prompting",
	sessionId: SESSION,
};

describe("what a claude-session checkpoint is made of", () => {
	it("is the generic field set and nothing else", () => {
		assert.deepStrictEqual(
			Object.keys(saved).sort(),
			[...checkpointFields].sort(),
			"the row's state grew a field nobody decided survives a restart",
		);
	});

	it("round-trips through JSON, so nothing SDK-shaped is in it", () => {
		expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
	});
});

describe("a restored claude session before anything reconnects it", () => {
	it("rehydrates with no Cmd, so nothing has opened a transport", () => {
		const [state, cmds] = machine.init(saved, {});
		assert.deepStrictEqual(cmds, [], "the rehydrating init opened something on its own");
		assert.strictEqual(state.phase, "idle");
		assert.strictEqual(state.sessionId, SESSION);
	});

	it("asks for a reconnect rather than a fresh open, so no new session can be minted", () => {
		const [state] = machine.init(saved, {});
		assert.deepStrictEqual(resumeMessages(state), [{type: "reconnect"}]);
	});

	it("enters reconnecting and asks for a republish and a resume by id", () => {
		const [restored] = machine.init(saved, {});
		const [state, cmds] = apply(restored, {type: "reconnect"});
		assert.strictEqual(state.phase, "reconnecting");
		assert.deepStrictEqual(cmds, [
			{type: "aiAgent.republish"},
			{type: "aiAgent.reconnect", cwd: CWD, sessionId: SESSION},
		]);
	});
});

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
				assert.deepStrictEqual(probe.starts[1], {cwd: CWD, resume: SESSION});
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
