/**
 * The `ai-agent-session` core as a program row imports it: the machine factory, its private
 * vocabulary, and the checkpoint's parse boundary. Importing this pulls in `@demlik/tea`, the
 * ports vocabulary and the transcript bounds — never a layer, a handler or a backend.
 */

export {
	MODE_UNSUPPORTED,
	PAGE_ERROR,
	PROMPT_ERROR,
	portRefused,
	START_ERROR,
	UNKNOWN_REQUEST,
} from "./failures.ts";
export {addUsage, foldEvent, foldItem, upsertItem, type WindowLimits} from "./fold.ts";
export {
	type AiAgentSessionMachine,
	type AiAgentSessionOptions,
	aiAgentSessionMachine,
} from "./machine.ts";
export {
	type AiAgentEventsSub,
	type AiAgentSessionCmd,
	type AiAgentSessionMsg,
	type AiAgentSessionSub,
	eventsSub,
	eventsSubId,
} from "./messages.ts";
export {isAiAgentSessionState, parseSessionState} from "./snapshot.ts";
export {
	type AgentFailure,
	type AiAgentSessionState,
	emptyUsage,
	type HistoryPage,
	initialState,
	lastAssistantId,
	type ModeState,
	phases,
	replyPending,
	restore,
	type UsageTotals,
} from "./state.ts";
