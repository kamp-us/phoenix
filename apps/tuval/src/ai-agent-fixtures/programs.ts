/**
 * Two program rows that speak the AI agent interface, written the way another slice would write
 * them: the only Tuval import is `src/ai-agent/ports/index.ts`, so this module is the standing
 * proof that the interface travels alone. It lives outside `src/ai-agent/` on purpose — a fixture
 * inside the directory could not tell whether the closure held.
 */

import {type Cmd, defineMachine} from "@demlik/tea";
import {mode, permission, prompt, transcript, transcriptPage} from "../ai-agent/ports/index.ts";
import {type AnyProgram, type PortSchema, type Program, ProgramId} from "../registry/program.ts";

type State = {readonly turns: number};
type Msg = {readonly type: "turn"};

const core = defineMachine<State, Msg, Cmd<never>, never, unknown>({
	init: (loaded) => [loaded ?? {turns: 0}, []],
	update: {turn: (state) => [{turns: state.turns + 1}, []]},
});

const row = (id: string, ports: Readonly<Record<string, PortSchema>>): AnyProgram =>
	({
		id: ProgramId.make(id),
		core,
		ports,
		handlers: {},
		capabilities: [],
		identity: {package: "@kampus/tuval", program: id, version: "1.0.0", digest: `sha256:${id}`},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Cmd<never>, never, unknown, never, never>;

/** The agent half: emits the tail, answers page requests, takes prompts, decisions and mode sets. */
export const agentPorts = {
	transcript: transcript.outbound(),
	pageRequest: transcriptPage.inbound(),
	pageReply: transcriptPage.outbound(),
	prompt: prompt.inbound(),
	permissionPending: permission.outbound(),
	permissionDecision: permission.inbound(),
	modeState: mode.outbound(),
	modeSet: mode.inbound(),
};

/** The window half: the exact mirror, so every route is one kind meeting itself. */
export const windowPorts = {
	transcript: transcript.inbound(),
	pageRequest: transcriptPage.outbound(),
	pageReply: transcriptPage.inbound(),
	prompt: prompt.outbound(),
	permissionPending: permission.inbound(),
	permissionDecision: permission.outbound(),
	modeState: mode.inbound(),
	modeSet: mode.outbound(),
};

export const agentSide = row("ai-agent-fixture", agentPorts);
export const windowSide = row("ai-agent-window-fixture", windowPorts);
