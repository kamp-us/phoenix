/**
 * The handler set against a real process: the layer's lifetime, the refusals that stay data, and
 * the projections that leave on the out-ports.
 *
 * Every case drives the row the way the kernel does — spawn, dispatch, read the committed state —
 * rather than calling a handler directly, because the thing under test is the round trip: a Cmd
 * the core emitted, a service call, a Msg back, and a port emission the window would have seen.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, type Scope} from "effect";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {memoryStores} from "../../durability/stores.ts";
import {NodeId} from "../../ports/graph.ts";
import {PortNotWired, ProcessPorts} from "../../ports/index.ts";
import {Processes} from "../../process/Processes.ts";
import type {ProcessTable} from "../../process/ProcessTable.ts";
import type {ProcessHandle} from "../../process/process.ts";
import {Registry} from "../../registry/Registry.ts";
import {type AiAgentSessionState, isAiAgentSessionState} from "../core/index.ts";
import type {
	ModelRef,
	ModePayload,
	PermissionPayload,
	TranscriptPagePayload,
} from "../ports/index.ts";
import {aiAgentProgram} from "../program.ts";
import {
	disconnects,
	history,
	mode as modeBrand,
	models,
	modes,
	PERMISSION_REQUEST,
	permissionTurn,
	plainReply,
	SESSION_ID,
} from "../service/fixtures/scripts.ts";
import {
	type AgentScript,
	ScriptedAiAgent,
	StartError,
	type StartOptions,
	TuvalAiAgent,
} from "../service/index.ts";
import {aiAgentPortNames} from "./publish.ts";

const PROGRAM = "ai-agent-session-test";

interface Probe {
	acquired: number;
	released: number;
	/** Prompts the layer was actually asked for; a refused prompt has to reach none of them. */
	prompts: number;
}

const probeOf = (): Probe => ({acquired: 0, released: 0, prompts: 0});

/** A backend that holds no session at all, whatever it is asked to open. */
const refusesEveryStart = (options: StartOptions) =>
	new StartError({
		reason: "session-not-found",
		cwd: options.cwd,
		detail: "this backend holds no session",
	});

/**
 * `ScriptedAiAgent.layer` with its build, its teardown and its prompts counted. Wrapping rather
 * than editing the fixture keeps the count on this test's side of the seam: what is asserted is
 * that the *row* builds the layer once per process and closes it once, not anything about the
 * script.
 *
 * `refuseStart` is the one behaviour the script itself cannot produce. A fresh session opens itself
 * now (#7925), so no caller is left that can hand `start` an id the backend does not hold — the
 * refusal a start answers with has to come from the layer.
 */
const countingLayer = (
	script: AgentScript,
	probe: Probe,
	refuseStart = false,
): Layer.Layer<TuvalAiAgent> =>
	Layer.effect(
		TuvalAiAgent,
		Effect.gen(function* () {
			probe.acquired += 1;
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					probe.released += 1;
				}),
			);
			const agent = Context.get(yield* Layer.build(ScriptedAiAgent.layer(script)), TuvalAiAgent);
			return {
				...agent,
				start: (options: StartOptions) =>
					refuseStart ? Effect.fail(refusesEveryStart(options)) : agent.start(options),
				prompt: (text: string, key?: string) =>
					Effect.suspend(() => {
						probe.prompts += 1;
						return agent.prompt(text, key);
					}),
			};
		}),
	);

interface Emitted {
	readonly port: string;
	readonly payload: unknown;
}

/** A `ProcessPorts` that records what a wired port received and refuses the rest, as a graph would. */
const recorder = (log: Array<Emitted>, wired: ReadonlySet<string>) =>
	ProcessPorts.of({
		emit: (port, payload) =>
			wired.has(port)
				? Effect.sync(() => {
						log.push({port, payload});
						return [];
					})
				: Effect.fail(new PortNotWired({node: NodeId.make("test"), port})),
	});

const allPorts = new Set(Object.values(aiAgentPortNames));

interface KernelOptions {
	readonly itemLimit?: number;
	readonly wired?: ReadonlySet<string>;
	/** Every open this row's layer answers is refused, so the process never leaves `idle`. */
	readonly refuseStart?: boolean;
}

const row = (script: AgentScript, probe: Probe, options: KernelOptions) =>
	aiAgentProgram({
		id: PROGRAM,
		layer: countingLayer(script, probe, options.refuseStart ?? false),
		config: {
			cwd: "/work",
			...(options.itemLimit === undefined ? {} : {itemLimit: options.itemLimit}),
		},
	});

const withKernel = <A, E>(
	script: AgentScript,
	probe: Probe,
	body: (
		spawn: Effect.Effect<ProcessHandle, unknown>,
		log: Array<Emitted>,
	) => Effect.Effect<A, E, Processes | ProcessTable | Scope.Scope>,
	options: KernelOptions = {},
) => {
	const log: Array<Emitted> = [];
	const ports = recorder(log, options.wired ?? allPorts);
	return Effect.gen(function* () {
		const processes = yield* Processes;
		const spawn = processes.spawn(row(script, probe, options).id, {
			services: Context.make(ProcessPorts, ports),
		});
		return yield* body(spawn, log);
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Processes.layer.pipe(
				Layer.provideMerge(Checkpoints.layer(memoryStores())),
				Layer.provideMerge(Registry.layer([row(script, probe, options)])),
			),
		),
	);
};

const eventually = (check: () => boolean) =>
	Effect.gen(function* () {
		for (let i = 0; i < 400 && !check(); i++) yield* Effect.sleep("5 millis");
	});

const sessionOf = (handle: ProcessHandle): AiAgentSessionState => {
	const state = handle.getState();
	assert.isTrue(isAiAgentSessionState(state), "the process holds an ai-agent-session state");
	return state as AiAgentSessionState;
};

const lastOn = (log: ReadonlyArray<Emitted>, port: string): unknown =>
	[...log].reverse().find((entry) => entry.port === port)?.payload;

describe("the AI agent handlers under a process", () => {
	it.live("acquires the layer in the process's Scope and releases it once on stop", () => {
		const probe = probeOf();
		return withKernel(plainReply, probe, (spawn) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* eventually(() => sessionOf(handle).phase === "ready");
				assert.deepStrictEqual([probe.acquired, probe.released], [1, 0]);
				yield* handle.stop;
				assert.deepStrictEqual([probe.acquired, probe.released], [1, 1]);
				yield* handle.stop;
				assert.strictEqual(probe.released, 1, "a second stop releases nothing again");
			}),
		);
	});

	it.live("gives two processes of one row two agents", () => {
		const probe = probeOf();
		return withKernel(plainReply, probe, (spawn) =>
			Effect.gen(function* () {
				const first = yield* spawn;
				yield* spawn;
				yield* eventually(() => probe.acquired === 2);
				assert.strictEqual(probe.acquired, 2);
				yield* first.stop;
				assert.strictEqual(probe.released, 1);
			}),
		);
	});

	it.live("carries a prompt to the layer and the reply back on the transcript port", () => {
		const probe = probeOf();
		return withKernel(plainReply, probe, (spawn, log) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* eventually(() => sessionOf(handle).phase === "ready");
				yield* handle.dispatch({type: "prompt", text: "hello", key: "k1"});
				yield* eventually(() => sessionOf(handle).transcript.items.length === 2);

				assert.deepStrictEqual(
					sessionOf(handle).transcript.items.map((item) => item.id),
					["u1", "a1"],
				);
				const published = lastOn(log, aiAgentPortNames.transcript);
				assert.deepStrictEqual(published, sessionOf(handle).transcript);
			}),
		);
	});

	it.live("answers a transcript-page request on the page reply port", () => {
		const probe = probeOf();
		return withKernel(plainReply, probe, (spawn, log) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* eventually(() => sessionOf(handle).phase === "ready");
				yield* handle.dispatch({type: "page", before: null, limit: 3});
				yield* eventually(() => sessionOf(handle).lastPage !== null);

				const page = lastOn(log, aiAgentPortNames.pageReply) as TranscriptPagePayload;
				assert.strictEqual(page.kind, "page");
				if (page.kind !== "page") return;
				assert.deepStrictEqual(
					page.items.map((item) => item.id),
					history.slice(-3).map((item) => item.id),
				);
				assert.strictEqual(page.next, page.items[0]?.id);
			}),
		);
	});

	it.live("crosses a permission event out and an inbound answer back in", () => {
		const probe = probeOf();
		return withKernel(permissionTurn, probe, (spawn, log) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* eventually(() => sessionOf(handle).phase === "ready");
				yield* handle.dispatch({type: "prompt", text: "delete it", key: "k1"});
				yield* eventually(() => sessionOf(handle).permissions[PERMISSION_REQUEST] !== undefined);

				const pending = lastOn(log, aiAgentPortNames.permissionPending) as PermissionPayload;
				assert.strictEqual(pending.kind, "pending");
				if (pending.kind !== "pending") return;
				assert.deepStrictEqual(Object.keys(pending.requests), [PERMISSION_REQUEST]);

				yield* handle.dispatch({
					type: "answer",
					request: PERMISSION_REQUEST,
					decision: "allow-once",
				});
				// The core drops the card on the `answer` Msg, but the port only clears once the
				// layer's `permission-resolved` event has come back round the stream.
				const clearedRequests = () => {
					const latest = lastOn(log, aiAgentPortNames.permissionPending) as
						| PermissionPayload
						| undefined;
					return latest?.kind === "pending" ? Object.keys(latest.requests) : ["unpublished"];
				};
				yield* eventually(() => clearedRequests().length === 0);
				assert.deepStrictEqual(clearedRequests(), []);
				assert.deepStrictEqual(Object.keys(sessionOf(handle).permissions), []);
			}),
		);
	});

	it.live("crosses a mode event out and an inbound set back in", () => {
		const probe = probeOf();
		return withKernel(plainReply, probe, (spawn, log) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* eventually(() => sessionOf(handle).modes.available.length === 2);

				const state = lastOn(log, aiAgentPortNames.modeState) as ModePayload;
				assert.deepStrictEqual(
					state.kind === "state" ? [state.current, [...state.available]] : ["unexpected", []],
					[modes.current, [...modes.available]],
				);

				yield* handle.dispatch({type: "setMode", mode: modeBrand("plan")});
				yield* eventually(() => sessionOf(handle).modes.current === modeBrand("plan"));
				const set = lastOn(log, aiAgentPortNames.modeState) as ModePayload;
				assert.strictEqual(set.kind === "state" ? set.current : null, modeBrand("plan"));
			}),
		);
	});

	// No port carries the model (#7981): the window reads it off the session state it already holds,
	// so this asserts the committed state rather than a payload on the log.
	it.live("folds the offered catalog into state and takes a setModel back to the layer", () => {
		const probe = probeOf();
		return withKernel(plainReply, probe, (spawn) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* eventually(() => sessionOf(handle).models.available.length === 2);
				assert.deepStrictEqual(sessionOf(handle).models.current, models.current);

				const sonnet = models.available[1] as ModelRef;
				yield* handle.dispatch({type: "setModel", model: sonnet});
				yield* eventually(() => sessionOf(handle).models.current?.id === sonnet.id);
				assert.deepStrictEqual(sessionOf(handle).models.current, sonnet);
				assert.isNull(sessionOf(handle).failure);
			}),
		);
	});

	it.live("windows a transcript past the limits and carries the omission out", () => {
		const probe = probeOf();
		return withKernel(
			plainReply,
			probe,
			(spawn, log) =>
				Effect.gen(function* () {
					const handle = yield* spawn;
					yield* eventually(() => sessionOf(handle).phase === "ready");
					// The replayed history is what overruns the limit, and only a resumed open replays
					// it. A fresh process opens itself with no resume now (#7925), so the reconnect is
					// what asks the backend for the session it already holds.
					yield* handle.dispatch({type: "reconnect"});
					yield* eventually(() => sessionOf(handle).transcript.omitted.items > 0);

					const tail = sessionOf(handle).transcript;
					assert.isBelow(tail.items.length, history.length);
					assert.strictEqual(tail.omitted.reason, "item-limit");
					assert.deepStrictEqual(lastOn(log, aiAgentPortNames.transcript), tail);
				}),
			{itemLimit: 4},
		);
	});

	it.live("turns a start the backend refuses into a failed Msg carrying the tag", () => {
		const probe = probeOf();
		return withKernel(
			plainReply,
			probe,
			(spawn) =>
				Effect.gen(function* () {
					const handle = yield* spawn;
					yield* eventually(() => sessionOf(handle).failure !== null);
					assert.deepStrictEqual(
						[sessionOf(handle).failure?.tag, sessionOf(handle).failure?.reason],
						["tuval/ai-agent/StartError", "session-not-found"],
					);
					assert.strictEqual(sessionOf(handle).phase, "idle");
				}),
			{refuseStart: true},
		);
	});

	// A refused open leaves the process at `idle`, which is the one phase a fresh session can still
	// reach a prompt from — and the phase every prompt outside `ready` is refused from.
	it.live("refuses a prompt outside ready as a failed Msg and sends nothing", () => {
		const probe = probeOf();
		return withKernel(
			plainReply,
			probe,
			(spawn) =>
				Effect.gen(function* () {
					const handle = yield* spawn;
					yield* eventually(() => sessionOf(handle).failure !== null);
					yield* handle.dispatch({type: "prompt", text: "too early", key: "k1"});
					assert.deepStrictEqual(
						[sessionOf(handle).failure?.tag, probe.prompts],
						["tuval/ai-agent/PromptError", 0],
					);
				}),
			{refuseStart: true},
		);
	});

	it.live("turns a disconnected event stream into a failed Msg", () => {
		const probe = probeOf();
		return withKernel(disconnects, probe, (spawn) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* eventually(() => sessionOf(handle).phase === "ready");
				yield* handle.dispatch({type: "prompt", text: "hello", key: "k1"});
				yield* eventually(() => sessionOf(handle).failure?.tag === "tuval/ai-agent/TransportError");
				assert.deepStrictEqual(
					[sessionOf(handle).failure?.tag, sessionOf(handle).failure?.reason],
					["tuval/ai-agent/TransportError", "disconnected"],
				);
			}),
		);
	});

	// The scripted layer never reconnects itself: once a turn disconnects, that build's `start`,
	// `prompt` and `page` all fail. So a reconnect that came back can only have rebuilt the layer,
	// which is what ruling 4 (#7570) says restore is.
	it.live("rebuilds the layer on reconnect and re-opens the event stream", () => {
		const probe = probeOf();
		return withKernel(disconnects, probe, (spawn, log) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* eventually(() => sessionOf(handle).phase === "ready");
				yield* handle.dispatch({type: "prompt", text: "hello", key: "k1"});
				yield* eventually(() => sessionOf(handle).failure?.tag === "tuval/ai-agent/TransportError");
				const downAt = log.length;

				yield* handle.dispatch({type: "reconnect"});
				yield* eventually(
					() =>
						probe.acquired === 2 && sessionOf(handle).transcript.items.length === history.length,
				);

				const session = sessionOf(handle);
				assert.deepStrictEqual(
					[probe.acquired, probe.released, session.phase, session.failure],
					[2, 1, "ready", null],
					"the dead transport is closed, a fresh one is built, and the session is back",
				);
				assert.strictEqual(session.sessionId, SESSION_ID);
				assert.isTrue(
					log.slice(downAt).some((entry) => entry.port === aiAgentPortNames.transcript),
					"the reopened stream published the resumed history on the transcript port",
				);
			}),
		);
	});

	it.live("counts the rebuilt transport once, not twice, when the process stops", () => {
		const probe = probeOf();
		return withKernel(disconnects, probe, (spawn) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* eventually(() => sessionOf(handle).phase === "ready");
				yield* handle.dispatch({type: "prompt", text: "hello", key: "k1"});
				yield* eventually(() => sessionOf(handle).failure !== null);
				yield* handle.dispatch({type: "reconnect"});
				yield* eventually(() => probe.acquired === 2);

				yield* handle.stop;
				assert.deepStrictEqual([probe.acquired, probe.released], [2, 2]);
			}),
		);
	});

	it.live("publishes nothing and fails nothing when a port has no route", () => {
		const probe = probeOf();
		return withKernel(
			plainReply,
			probe,
			(spawn, log) =>
				Effect.gen(function* () {
					const handle = yield* spawn;
					yield* eventually(() => sessionOf(handle).phase === "ready");
					yield* handle.dispatch({type: "prompt", text: "hello", key: "k1"});
					yield* eventually(() => sessionOf(handle).transcript.items.length === 2);
					assert.deepStrictEqual(log, []);
				}),
			{wired: new Set<string>()},
		);
	});
});
