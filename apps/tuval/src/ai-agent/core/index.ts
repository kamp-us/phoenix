/**
 * The `ai-agent-session` core as a program row imports it: the machine factory, its private
 * vocabulary, and the checkpoint's parse boundary. Importing this pulls in `@demlik/tea`, the
 * ports vocabulary and the transcript bounds — never a layer, a handler or a backend.
 */

export {
	MODE_UNSUPPORTED,
	MODEL_UNSUPPORTED,
	PAGE_ERROR,
	PROMPT_ERROR,
	portRefused,
	promptQueueFull,
	promptUnqueued,
	START_ERROR,
	THINKING_UNSUPPORTED,
	TRANSPORT_ERROR,
	UNKNOWN_REQUEST,
} from "./failures.ts";
export {
	addUsage,
	foldEvent,
	foldItem,
	promptItem,
	promptItemId,
	upsertItem,
	type WindowLimits,
} from "./fold.ts";
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
export {
	enqueue,
	isQueueFull,
	type QueuedPrompt,
	queueLimit,
	releaseQueued,
} from "./queue.ts";
export {
	markTurnRunning,
	noteSend,
	type PendingSend,
	pendingSend,
	runningSend,
	type SendOutcome,
	sendAfterFailure,
	sendLimit,
	sendOutcome,
	settleAccepted,
	settledBy,
	settlePending,
	type TurnProgress,
} from "./sends.ts";
export {
	isAiAgentSessionState,
	loadCheckpoint,
	parseSessionState,
	readCheckpoint,
	SPENT_BEFORE_LEDGER,
	withCheckpointDefaults,
	withUsageLedger,
} from "./snapshot.ts";
export {
	type AgentFailure,
	type AiAgentSessionState,
	type CheckpointField,
	checkpointFields,
	checkpointWorthy,
	emptyUsage,
	type HistoryPage,
	holdsPartialItem,
	holdsRunningSubagent,
	type Interruption,
	initialState,
	lastAssistantId,
	type ModelState,
	type ModeState,
	phases,
	restore,
	settleRunningSubagents,
	settleTurn,
	type ThinkingState,
	type TurnUsage,
	type UsageLedger,
	type UsageTotals,
	usageTotals,
} from "./state.ts";
