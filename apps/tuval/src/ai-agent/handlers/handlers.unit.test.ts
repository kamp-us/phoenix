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
import type {ModePayload, PermissionPayload, TranscriptPagePayload} from "../ports/index.ts";
import {aiAgentProgram} from "../program.ts";
import {
	disconnects,
	history,
	mode as modeBrand,
	modes,
	PERMISSION_REQUEST,
	permissionTurn,
	plainReply,
	SESSION_ID,
} from "../service/fixtures/scripts.ts";
import {type AgentScript, ScriptedAiAgent, TuvalAiAgent} from "../service/index.ts";
import {aiAgentPortNames} from "./publish.ts";

const PROGRAM = "ai-agent-session-test";

interface Probe {
	acquired: number;
	released: number;
}

/**
 * `ScriptedAiAgent.layer` with its build and its teardown counted. Wrapping rather than editing the
 * fixture keeps the count on this test's side of the seam: what is asserted is that the *row*
 * builds the layer once per process and closes it once, not anything about the script.
 */
const countingLayer = (script: AgentScript, probe: Probe): Layer.Layer<TuvalAiAgent> =>
	Layer.effect(
		TuvalAiAgent,
		Effect.gen(function* () {
			probe.acquired += 1;
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					probe.released += 1;
				}),
			);
			return Context.get(yield* Layer.build(ScriptedAiAgent.layer(script)), TuvalAiAgent);
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

const row = (script: AgentScript, probe: Probe, itemLimit?: number) =>
	aiAgentProgram({
		id: PROGRAM,
		layer: countingLayer(script, probe),
		config: {cwd: "/work", ...(itemLimit === undefined ? {} : {itemLimit})},
	});

const withKernel = <A, E>(
	script: AgentScript,
	probe: Probe,
	body: (
		spawn: Effect.Effect<ProcessHandle, unknown>,
		log: Array<Emitted>,
	) => Effect.Effect<A, E, Processes | ProcessTable | Scope.Scope>,
	options: {readonly itemLimit?: number; readonly wired?: ReadonlySet<string>} = {},
) => {
	const log: Array<Emitted> = [];
	const ports = recorder(log, options.wired ?? allPorts);
	return Effect.gen(function* () {
		const processes = yield* Processes;
		const spawn = processes.spawn(row(script, probe, options.itemLimit).id, {
			services: Context.make(ProcessPorts, ports),
		});
		return yield* body(spawn, log);
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Processes.layer.pipe(
				Layer.provideMerge(Checkpoints.layer(memoryStores())),
				Layer.provideMerge(Registry.layer([row(script, probe, options.itemLimit)])),
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
		const probe: Probe = {acquired: 0, released: 0};
		return withKernel(plainReply, probe, (spawn) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				assert.deepStrictEqual([probe.acquired, probe.released], [0, 0]);
				yield* handle.dispatch({type: "start", cwd: "/work", resume: null});
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
		const probe: Probe = {acquired: 0, released: 0};
		return withKernel(plainReply, probe, (spawn) =>
			Effect.gen(function* () {
				const first = yield* spawn;
				const second = yield* spawn;
				yield* first.dispatch({type: "start", cwd: "/work", resume: null});
				yield* second.dispatch({type: "start", cwd: "/work", resume: null});
				yield* eventually(() => probe.acquired === 2);
				assert.strictEqual(probe.acquired, 2);
				yield* first.stop;
				assert.strictEqual(probe.released, 1);
			}),
		);
	});

	it.live("carries a prompt to the layer and the reply back on the transcript port", () => {
		const probe: Probe = {acquired: 0, released: 0};
		return withKernel(plainReply, probe, (spawn, log) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* handle.dispatch({type: "start", cwd: "/work", resume: null});
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
		const probe: Probe = {acquired: 0, released: 0};
		return withKernel(plainReply, probe, (spawn, log) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* handle.dispatch({type: "start", cwd: "/work", resume: null});
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
		const probe: Probe = {acquired: 0, released: 0};
		return withKernel(permissionTurn, probe, (spawn, log) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* handle.dispatch({type: "start", cwd: "/work", resume: null});
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
		const probe: Probe = {acquired: 0, released: 0};
		return withKernel(plainReply, probe, (spawn, log) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* handle.dispatch({type: "start", cwd: "/work", resume: null});
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

	it.live("windows a transcript past the limits and carries the omission out", () => {
		const probe: Probe = {acquired: 0, released: 0};
		return withKernel(
			plainReply,
			probe,
			(spawn, log) =>
				Effect.gen(function* () {
					const handle = yield* spawn;
					yield* handle.dispatch({type: "start", cwd: "/work", resume: SESSION_ID});
					yield* eventually(() => sessionOf(handle).transcript.omitted.items > 0);

					const tail = sessionOf(handle).transcript;
					assert.isBelow(tail.items.length, history.length);
					assert.strictEqual(tail.omitted.reason, "item-limit");
					assert.deepStrictEqual(lastOn(log, aiAgentPortNames.transcript), tail);
				}),
			{itemLimit: 4},
		);
	});

	it.live("turns a session-not-found resume into a failed Msg carrying the tag", () => {
		const probe: Probe = {acquired: 0, released: 0};
		return withKernel(plainReply, probe, (spawn) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* handle.dispatch({type: "start", cwd: "/work", resume: "no-such-session"});
				yield* eventually(() => sessionOf(handle).failure !== null);
				assert.deepStrictEqual(
					[sessionOf(handle).failure?.tag, sessionOf(handle).failure?.reason],
					["tuval/ai-agent/StartError", "session-not-found"],
				);
				assert.strictEqual(sessionOf(handle).phase, "idle");
			}),
		);
	});

	it.live("refuses a prompt outside ready as a failed Msg and sends nothing", () => {
		const probe: Probe = {acquired: 0, released: 0};
		return withKernel(plainReply, probe, (spawn) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* handle.dispatch({type: "prompt", text: "too early", key: "k1"});
				assert.deepStrictEqual(
					[sessionOf(handle).failure?.tag, probe.acquired],
					["tuval/ai-agent/PromptError", 0],
				);
			}),
		);
	});

	it.live("turns a disconnected event stream into a failed Msg", () => {
		const probe: Probe = {acquired: 0, released: 0};
		return withKernel(disconnects, probe, (spawn) =>
			Effect.gen(function* () {
				const handle = yield* spawn;
				yield* handle.dispatch({type: "start", cwd: "/work", resume: null});
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

	it.live("publishes nothing and fails nothing when a port has no route", () => {
		const probe: Probe = {acquired: 0, released: 0};
		return withKernel(
			plainReply,
			probe,
			(spawn, log) =>
				Effect.gen(function* () {
					const handle = yield* spawn;
					yield* handle.dispatch({type: "start", cwd: "/work", resume: null});
					yield* eventually(() => sessionOf(handle).phase === "ready");
					yield* handle.dispatch({type: "prompt", text: "hello", key: "k1"});
					yield* eventually(() => sessionOf(handle).transcript.items.length === 2);
					assert.deepStrictEqual(log, []);
				}),
			{wired: new Set<string>()},
		);
	});
});
