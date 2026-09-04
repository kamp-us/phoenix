/**
 * The AI agent interface as another program imports it. This file and the two beside it are the
 * whole surface: importing it pulls in `effect` and the kernel's program row, and nothing else
 * under `src/ai-agent/`, so a program can speak the interface without depending on any agent
 * implementation. `boundary.unit.test.ts` holds that closure.
 */

export {
	isModePayload,
	isPermissionPayload,
	isPermissionRequest,
	isPromptPayload,
	isTranscriptPagePayload,
	isTranscriptPayload,
	isWindowOmission,
	Mode,
	type ModePayload,
	type PermissionDecision,
	type PermissionPayload,
	type PermissionRequest,
	type PromptPayload,
	type TranscriptPagePayload,
	type TranscriptPayload,
	type WindowOmission,
} from "./payloads.ts";
export {
	type AgentPort,
	type AgentPortPayload,
	agentPorts,
	mode,
	permission,
	prompt,
	transcript,
	transcriptPage,
} from "./ports.ts";
export {
	type AssistantItem,
	boundToolResult,
	byteLength,
	ItemId,
	isJsonValue,
	isTranscriptItem,
	isTranscriptItems,
	type JsonValue,
	type ResultOmission,
	type SystemItem,
	TOOL_RESULT_BYTE_LIMIT,
	type ToolItem,
	type ToolResult,
	type ToolStatus,
	type TranscriptItem,
	type UserItem,
} from "./transcript-item.ts";
