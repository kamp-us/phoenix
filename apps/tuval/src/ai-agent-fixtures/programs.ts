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
	pageRequest: transcriptPage.ends.request.inbound(),
	pageReply: transcriptPage.ends.page.outbound(),
	prompt: prompt.inbound(),
	permissionPending: permission.ends.pending.outbound(),
	permissionDecision: permission.ends.decision.inbound(),
	modeState: mode.ends.state.outbound(),
	modeSet: mode.ends.set.inbound(),
};

/** The window half: the exact mirror, so every route is one kind meeting itself. */
export const windowPorts = {
	transcript: transcript.inbound(),
	pageRequest: transcriptPage.ends.request.outbound(),
	pageReply: transcriptPage.ends.page.inbound(),
	prompt: prompt.outbound(),
	permissionPending: permission.ends.pending.inbound(),
	permissionDecision: permission.ends.decision.outbound(),
	modeState: mode.ends.state.inbound(),
	modeSet: mode.ends.set.outbound(),
};

export const agentSide = row("ai-agent-fixture", agentPorts);
export const windowSide = row("ai-agent-window-fixture", windowPorts);
