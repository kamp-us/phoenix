/**
 * The AI agent service as a program imports it: the `TuvalAiAgent` tag every generic caller
 * yields, the errors it can fail with, the events it emits, and the scripted layer tests run on.
 */

export {
	ModeUnsupported,
	PageError,
	type PageReason,
	PromptError,
	type PromptReason,
	StartError,
	type StartReason,
	TransportError,
	type TransportReason,
	UnknownRequest,
} from "./errors.ts";
export type {
	AgentEvent,
	ItemEvent,
	ModeEvent,
	PermissionEvent,
	PermissionResolvedEvent,
	Phase,
	PhaseEvent,
	UsageEvent,
} from "./events.ts";
export {ScriptedAiAgent} from "./ScriptedAiAgent.ts";
export type {AgentScript, ScriptedModes, ScriptedTurn} from "./script.ts";
export {
	type StartedSession,
	type StartOptions,
	type TranscriptPage,
	TuvalAiAgent,
	type TuvalAiAgentApi,
} from "./TuvalAiAgent.ts";
