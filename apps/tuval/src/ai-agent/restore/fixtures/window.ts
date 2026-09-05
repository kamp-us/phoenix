/**
 * The window a headless proof reads an agent through: it records every payload that reached it,
 * in arrival order, and emits whatever it is told to say.
 *
 * Its own state is checkpointed like any process, so what it saw before a restart is still there
 * after it, and a proof reads the new arrivals as the tail past a mark it took. One copy, because
 * both restore proofs — the scripted one beside this file and the Pi one under `src/pi/restore/` —
 * need the same eight port keys wired the same way, and two copies would be two things to keep in
 * step.
 */

import {defineMachine} from "@demlik/tea";
import {Effect} from "effect";
import {ProcessPorts} from "../../../ports/ProcessPorts.ts";
import {type AnyProgram, type Program, ProgramId} from "../../../registry/program.ts";
import {aiAgentPortNames} from "../../handlers/index.ts";
import {mode, permission, prompt, transcript, transcriptPage} from "../../ports/index.ts";

export const WINDOW_PROGRAM = "window-stand-in";

export interface Arrival {
	readonly port: string;
	readonly payload: unknown;
}

type WindowState = {readonly seen: ReadonlyArray<Arrival>};
type WindowMsg =
	| {readonly type: "took"; readonly port: string; readonly payload: unknown}
	| {readonly type: "say"; readonly port: string; readonly payload: unknown};
type WindowCmd = {readonly type: "emit"; readonly port: string; readonly payload: unknown};

const took =
	(port: string) =>
	(payload: unknown): WindowMsg => ({type: "took", port, payload});

export const windowProgram: AnyProgram = {
	id: ProgramId.make(WINDOW_PROGRAM),
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
		program: WINDOW_PROGRAM,
		version: "1.0.0",
		digest: `sha256:${WINDOW_PROGRAM}`,
	},
	placement: {host: "local"},
} satisfies Program<WindowState, WindowMsg, WindowCmd, never, unknown, unknown, ProcessPorts>;

/**
 * The graph half a window node declares: every in-port of the agent's it drives, routed back at
 * the agent node. The agent's own half is the mirror, and both proofs wire the same eight keys.
 */
export const windowRoutes = (agentNode: string) => [
	{port: aiAgentPortNames.prompt, to: {node: agentNode, port: aiAgentPortNames.prompt}},
	{port: aiAgentPortNames.pageRequest, to: {node: agentNode, port: aiAgentPortNames.pageRequest}},
	{
		port: aiAgentPortNames.permissionDecision,
		to: {node: agentNode, port: aiAgentPortNames.permissionDecision},
	},
	{port: aiAgentPortNames.modeSet, to: {node: agentNode, port: aiAgentPortNames.modeSet}},
];

/** The agent half: the four projections a window renders, routed at the window node. */
export const agentRoutes = (windowNode: string) => [
	{port: aiAgentPortNames.transcript, to: {node: windowNode, port: aiAgentPortNames.transcript}},
	{port: aiAgentPortNames.pageReply, to: {node: windowNode, port: aiAgentPortNames.pageReply}},
	{
		port: aiAgentPortNames.permissionPending,
		to: {node: windowNode, port: aiAgentPortNames.permissionPending},
	},
	{port: aiAgentPortNames.modeState, to: {node: windowNode, port: aiAgentPortNames.modeState}},
];
