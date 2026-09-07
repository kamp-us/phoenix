/**
 * The AI agent service as a program imports it: the `TuvalAiAgent` tag every generic caller
 * yields, the errors it can fail with, the events it emits, and the scripted layer tests run on.
 */

export type {
	AgentEvent,
	ItemEvent,
	ModeEvent,
	ModelEvent,
	PermissionEvent,
	PermissionResolvedEvent,
	Phase,
	PhaseEvent,
	ThinkingEvent,
	UsageEvent,
} from "../events.ts";
export {
	ListError,
	type ListReason,
	ModelUnsupported,
	ModeUnsupported,
	PageError,
	type PageReason,
	PromptError,
	type PromptReason,
	StartError,
	type StartReason,
	ThinkingUnsupported,
	TranscriptError,
	type TranscriptReason,
	TransportError,
	type TransportReason,
	UnknownRequest,
} from "./errors.ts";
export {ScriptedAiAgent} from "./ScriptedAiAgent.ts";
export type {
	AgentScript,
	ScriptedAnswer,
	ScriptedModels,
	ScriptedModes,
	ScriptedPlan,
	ScriptedRequest,
	ScriptedSpells,
	ScriptedThinking,
	ScriptedTurn,
} from "./script.ts";
export {
	newestFirst,
	type SessionDraft,
	type SessionSummary,
	sessionSummary,
} from "./sessions.ts";
export {
	type ResumeTarget,
	type StartedSession,
	type StartOptions,
	type TranscriptPage,
	type TranscriptQuery,
	TuvalAiAgent,
	type TuvalAiAgentApi,
} from "./TuvalAiAgent.ts";
