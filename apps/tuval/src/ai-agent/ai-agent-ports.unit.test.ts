/**
 * The five ports, end to end, over a real compiled graph: one `aiAgentProgram` node wired to a
 * stand-in window node, launched by the kernel, with every assertion made on what crossed a port.
 *
 * The point of the interface is that a window can drive any agent knowing only the eight port keys,
 * so the test drives it the same way. The one read outside a port is the session's own phase, which
 * is how a caller waits for the open the spawn started (#7925) — nothing dispatches `start`, and
 * the interface deliberately does not carry it.
 *
 * It sits in the unit tier because it stands nothing up outside this process: the tiers split on
 * that, and the scripted layer talks to nothing.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, type Scope} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {launch} from "../launch/launch.ts";
import {compile} from "../ports/compile.ts";
import {type Graph, NodeId} from "../ports/graph.ts";
import {ProcessPorts} from "../ports/ProcessPorts.ts";
import {open} from "../ports/wiring.ts";
import {Processes} from "../process/Processes.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {isAiAgentSessionState} from "./core/index.ts";
import {aiAgentPortNames} from "./handlers/index.ts";
import type {
	ModePayload,
	PermissionPayload,
	TranscriptPagePayload,
	TranscriptPayload,
} from "./ports/index.ts";
import {mode, permission, prompt, transcript, transcriptPage} from "./ports/index.ts";
import {aiAgentProgram} from "./program.ts";
import {
	history,
	mode as modeBrand,
	modes,
	PERMISSION_REQUEST,
	permissionTurn,
	plainReply,
} from "./service/fixtures/scripts.ts";
import {type AgentScript, ScriptedAiAgent} from "./service/index.ts";

interface Arrival {
	readonly port: string;
	readonly payload: unknown;
}

type WindowState = {readonly seen: ReadonlyArray<Arrival>};
type WindowMsg =
	| {readonly type: "took"; readonly port: string; readonly payload: unknown}
	| {readonly type: "say"; readonly port: string; readonly payload: unknown};
type WindowCmd = {readonly type: "emit"; readonly port: string; readonly payload: unknown};

const AGENT = ProgramId.make("ai-agent-session");
const WINDOW = ProgramId.make("window-stand-in");

const took =
	(port: string) =>
	(payload: unknown): WindowMsg => ({type: "took", port, payload});

/** The mirror of the agent's eight keys: every out-port of one is an in-port of the other. */
const windowProgram: AnyProgram = {
	id: WINDOW,
	core: defineMachine<WindowState, WindowMsg, WindowCmd, never, unknown>({
		init: (loaded) => [loaded ?? {seen: []}, []],
		update: {
			took: (state, msg) => [{seen: [...state.seen, {port: msg.port, payload: msg.payload}]}, []],
			say: (state, msg) => [state, [{type: "emit", port: msg.port, payload: msg.payload}]],
		},
		interpret: {emit: () => Promise.resolve()},
	}),
	ports: {
		[aiAgentPortNames.transcript]: transcript.inbound(),
		[aiAgentPortNames.pageRequest]: transcriptPage.outbound(),
		[aiAgentPortNames.pageReply]: transcriptPage.inbound(),
		[aiAgentPortNames.prompt]: prompt.outbound(),
		[aiAgentPortNames.permissionPending]: permission.inbound(),
		[aiAgentPortNames.permissionDecision]: permission.outbound(),
		[aiAgentPortNames.modeState]: mode.inbound(),
		[aiAgentPortNames.modeSet]: mode.outbound(),
	},
	receive: {
		[aiAgentPortNames.transcript]: took(aiAgentPortNames.transcript),
		[aiAgentPortNames.pageReply]: took(aiAgentPortNames.pageReply),
		[aiAgentPortNames.permissionPending]: took(aiAgentPortNames.permissionPending),
		[aiAgentPortNames.modeState]: took(aiAgentPortNames.modeState),
	},
	handlers: {
		emit: (cmd: WindowCmd) =>
			Effect.gen(function* () {
				yield* (yield* ProcessPorts).emit(cmd.port, cmd.payload);
				return [] as ReadonlyArray<WindowMsg>;
			}),
	},
	capabilities: [],
	identity: {
		package: "@kampus/tuval",
		program: "window-stand-in",
		version: "1.0.0",
		digest: "sha256:window-stand-in",
	},
	placement: {host: "local"},
} satisfies Program<WindowState, WindowMsg, WindowCmd, never, unknown, unknown, ProcessPorts>;

const agentNode = NodeId.make("agent");
const windowNode = NodeId.make("window");

const graph: Graph = {
	nodes: [
		{
			id: agentNode,
			program: AGENT,
			on: [
				{
					port: aiAgentPortNames.transcript,
					to: {node: windowNode, port: aiAgentPortNames.transcript},
				},
				{
					port: aiAgentPortNames.pageReply,
					to: {node: windowNode, port: aiAgentPortNames.pageReply},
				},
				{
					port: aiAgentPortNames.permissionPending,
					to: {node: windowNode, port: aiAgentPortNames.permissionPending},
				},
				{
					port: aiAgentPortNames.modeState,
					to: {node: windowNode, port: aiAgentPortNames.modeState},
				},
			],
		},
		{
			id: windowNode,
			program: WINDOW,
			on: [
				{port: aiAgentPortNames.prompt, to: {node: agentNode, port: aiAgentPortNames.prompt}},
				{
					port: aiAgentPortNames.pageRequest,
					to: {node: agentNode, port: aiAgentPortNames.pageRequest},
				},
				{
					port: aiAgentPortNames.permissionDecision,
					to: {node: agentNode, port: aiAgentPortNames.permissionDecision},
				},
				{port: aiAgentPortNames.modeSet, to: {node: agentNode, port: aiAgentPortNames.modeSet}},
			],
		},
	],
};

const agentRow = (script: AgentScript) =>
	aiAgentProgram({
		id: AGENT,
		layer: ScriptedAiAgent.layer(script),
		config: {cwd: "/work"},
	});

const eventually = (check: () => boolean) =>
	Effect.gen(function* () {
		for (let i = 0; i < 400 && !check(); i++) yield* Effect.sleep("5 millis");
	});

const onGraph = <A, E>(
	script: AgentScript,
	body: (
		agent: {
			readonly dispatch: (msg: unknown) => Effect.Effect<void, unknown>;
			readonly state: () => unknown;
		},
		window: {readonly say: (port: string, payload: unknown) => Effect.Effect<void, unknown>},
		seen: () => ReadonlyArray<Arrival>,
	) => Effect.Effect<A, E, Scope.Scope>,
) =>
	Effect.gen(function* () {
		const compiled = yield* compile(graph);
		const wiring = yield* open(compiled);
		const launched = yield* launch(compiled, wiring);
		const agent = launched.find((entry) => entry.node === agentNode);
		const window = launched.find((entry) => entry.node === windowNode);
		assert.isDefined(agent);
		assert.isDefined(window);
		const agentHandle = agent!.handle;
		const windowHandle = window!.handle;
		return yield* body(
			{dispatch: (msg) => agentHandle.dispatch(msg as never), state: () => agentHandle.getState()},
			{
				say: (port, payload) => windowHandle.dispatch({type: "say", port, payload} as never),
			},
			() => (windowHandle.getState() as WindowState).seen,
		);
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Processes.layer.pipe(
				Layer.provideMerge(Checkpoints.layer(memoryStores())),
				Layer.provideMerge(Registry.layer([agentRow(script), windowProgram])),
			),
		),
	);

const latest = (seen: ReadonlyArray<Arrival>, port: string): unknown =>
	[...seen].reverse().find((arrival) => arrival.port === port)?.payload;

/** Spawning the row is what opens the session (#7925), so a caller only waits for it. */
const started = (agent: {readonly state: () => unknown}) =>
	eventually(() => {
		const state = agent.state();
		return isAiAgentSessionState(state) && state.phase === "ready";
	});

describe("the AI agent interface over a compiled graph", () => {
	it.live("carries a prompt in and the windowed transcript out", () =>
		onGraph(plainReply, (agent, window, seen) =>
			Effect.gen(function* () {
				yield* started(agent);
				yield* window.say(aiAgentPortNames.prompt, {text: "hello", key: "k1"});
				yield* eventually(() => {
					const payload = latest(seen(), aiAgentPortNames.transcript) as
						| TranscriptPayload
						| undefined;
					return (payload?.items.length ?? 0) === 2;
				});
				const payload = latest(seen(), aiAgentPortNames.transcript) as TranscriptPayload;
				assert.deepStrictEqual(
					payload.items.map((item) => item.id),
					["u1", "a1"],
				);
				assert.strictEqual(payload.omitted.reason, "none");
			}),
		),
	);

	it.live("answers a transcript-page request with a page", () =>
		onGraph(plainReply, (agent, window, seen) =>
			Effect.gen(function* () {
				yield* started(agent);
				yield* window.say(aiAgentPortNames.pageRequest, {
					kind: "request",
					before: null,
					limit: 3,
				});
				yield* eventually(() => latest(seen(), aiAgentPortNames.pageReply) !== undefined);
				const page = latest(seen(), aiAgentPortNames.pageReply) as TranscriptPagePayload;
				assert.strictEqual(page.kind, "page");
				if (page.kind !== "page") return;
				assert.deepStrictEqual(
					page.items.map((item) => item.id),
					history.slice(-3).map((item) => item.id),
				);
			}),
		),
	);

	it.live("raises a permission card and takes the answer back in", () =>
		onGraph(permissionTurn, (agent, window, seen) =>
			Effect.gen(function* () {
				yield* started(agent);
				yield* window.say(aiAgentPortNames.prompt, {text: "delete it", key: "k1"});
				const pending = () =>
					latest(seen(), aiAgentPortNames.permissionPending) as PermissionPayload | undefined;
				const keys = () => {
					const payload = pending();
					return payload?.kind === "pending" ? Object.keys(payload.requests) : null;
				};
				yield* eventually(() => (keys() ?? []).includes(PERMISSION_REQUEST));
				assert.deepStrictEqual(keys(), [PERMISSION_REQUEST]);

				yield* window.say(aiAgentPortNames.permissionDecision, {
					kind: "decision",
					request: PERMISSION_REQUEST,
					decision: "allow-once",
				});
				yield* eventually(() => keys()?.length === 0);
				assert.deepStrictEqual(keys(), []);
			}),
		),
	);

	it.live("publishes the mode list and takes a set back in", () =>
		onGraph(plainReply, (agent, window, seen) =>
			Effect.gen(function* () {
				yield* started(agent);
				const current = () => {
					const payload = latest(seen(), aiAgentPortNames.modeState) as ModePayload | undefined;
					return payload?.kind === "state" ? payload.current : null;
				};
				yield* eventually(() => current() === modes.current);
				assert.strictEqual(current(), modes.current);

				yield* window.say(aiAgentPortNames.modeSet, {kind: "set", mode: modeBrand("plan")});
				yield* eventually(() => current() === modeBrand("plan"));
				assert.strictEqual(current(), modeBrand("plan"));
			}),
		),
	);
});
