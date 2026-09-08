import type {JsonValue} from "./json.ts";
import type {ModelRef} from "./model.ts";

export interface TextContent {
	readonly type: "text";
	readonly text: string;
}

export interface ThinkingContent {
	readonly type: "thinking";
	readonly thinking: string;
	readonly redacted?: boolean;
}

export interface ImageContent {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export interface ToolCallContent {
	readonly type: "toolCall";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: JsonValue;
}

export type UserContent = TextContent | ImageContent;
export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;
export type ToolContent = TextContent | ImageContent;

export interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning?: number;
	readonly totalTokens: number;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}

export interface UserTranscriptItem {
	readonly id: string;
	readonly role: "user";
	readonly content: UserContent[];
	readonly timestamp: number;
}

interface AssistantTranscriptItemFields {
	readonly id: string;
	readonly role: "assistant";
	readonly content: AssistantContent[];
	readonly model: ModelRef;
	readonly responseModel?: string;
	readonly usage?: Usage;
	readonly timestamp: number;
}

export interface StreamingAssistantTranscriptItem extends AssistantTranscriptItemFields {
	readonly status: "streaming";
}

export interface CompleteAssistantTranscriptItem extends AssistantTranscriptItemFields {
	readonly status: "complete";
	readonly stopReason: "stop" | "length" | "toolUse";
}

export interface ErrorAssistantTranscriptItem extends AssistantTranscriptItemFields {
	readonly status: "error";
	readonly stopReason: "error";
	readonly errorMessage?: string;
}

export interface AbortedAssistantTranscriptItem extends AssistantTranscriptItemFields {
	readonly status: "aborted";
	readonly stopReason: "aborted";
	readonly errorMessage?: string;
}

export type AssistantTranscriptItem =
	| StreamingAssistantTranscriptItem
	| CompleteAssistantTranscriptItem
	| ErrorAssistantTranscriptItem
	| AbortedAssistantTranscriptItem;

interface ToolTranscriptItemFields {
	readonly id: string;
	readonly role: "tool";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: JsonValue;
	readonly content: ToolContent[];
	readonly details?: JsonValue;
	readonly usage?: Usage;
	readonly timestamp: number;
}

export interface RunningToolTranscriptItem extends ToolTranscriptItemFields {
	readonly status: "running";
	readonly isError: false;
}

export interface CompleteToolTranscriptItem extends ToolTranscriptItemFields {
	readonly status: "complete";
	readonly isError: false;
}

export interface ErrorToolTranscriptItem extends ToolTranscriptItemFields {
	readonly status: "error";
	readonly isError: true;
}

export type ToolTranscriptItem =
	| RunningToolTranscriptItem
	| CompleteToolTranscriptItem
	| ErrorToolTranscriptItem;

export type TranscriptItem = UserTranscriptItem | AssistantTranscriptItem | ToolTranscriptItem;
