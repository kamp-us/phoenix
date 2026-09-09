/**
 * The AI agent interface as another program imports it. This file and the two beside it are the
 * whole surface: importing it pulls in `effect` and the kernel's program row, and nothing else
 * under `src/ai-agent/`, so a program can speak the interface without depending on any agent
 * implementation. `boundary.unit.test.ts` holds that closure.
 */

export {type CommandRef, isCommandRef} from "./command.ts";
export {isModelRef, type ModelRef, sameModel} from "./model.ts";
export {
	isModePayload,
	isModeSet,
	isModeState,
	isPendingPermission,
	isPermissionAnswer,
	isPermissionPayload,
	isPermissionPendingSet,
	isPermissionRequest,
	isPromptPayload,
	isTranscriptPagePayload,
	isTranscriptPageReply,
	isTranscriptPageRequest,
	isTranscriptPayload,
	isTurnResult,
	isWindowOmission,
	Mode,
	type ModePayload,
	type ModeSet,
	type ModeState,
	type PendingPermission,
	type PermissionAnswer,
	type PermissionDecision,
	type PermissionPayload,
	type PermissionPendingSet,
	type PermissionProgress,
	type PermissionRequest,
	type PromptPayload,
	type TranscriptPagePayload,
	type TranscriptPageReply,
	type TranscriptPageRequest,
	type TranscriptPayload,
	type TurnResult,
	type WindowOmission,
} from "./payloads.ts";
export {
	type AgentPort,
	type AgentPortPayload,
	agentPorts,
	mode,
	type PortDefinition,
	type PortEnd,
	permission,
	prompt,
	result,
	status,
	type TwoWayPort,
	title,
	transcript,
	transcriptPage,
} from "./ports.ts";
export {
	isSubagentSlot,
	isSubagentSlots,
	type SubagentSlot,
	type SubagentStatus,
} from "./subagent.ts";
export {
	isThinkingLevel,
	type ThinkingLevel,
	thinkingLevels,
} from "./thinking.ts";
export {
	type AssistantItem,
	boundToolResult,
	byteLength,
	type CompactionItem,
	ItemId,
	isJsonValue,
	isTranscriptItem,
	isTranscriptItems,
	type JsonValue,
	newestBackendItemId,
	type ResultOmission,
	type SystemItem,
	type ThinkingItem,
	TOOL_RESULT_BYTE_LIMIT,
	type ToolItem,
	type ToolResult,
	type ToolStatus,
	type TranscriptItem,
	type UserItem,
} from "./transcript-item.ts";
