/**
 * Pi's in-memory `AgentMessage[]` → the wire's `TranscriptItem[]`.
 *
 * Every schema on the wire is a strict object (`additionalProperties: false`), and Pi's own
 * content carries fields the wire does not declare — `textSignature` on text, `thinkingSignature`
 * on thinking, `cacheWrite1h` on usage (`@earendil-works/pi-ai` `dist/types.d.ts:237-286`). So
 * this is a projection, not a cast: handing a message straight to `encodeServerMessage` fails
 * validation the first time a provider fills one of those in.
 *
 * Pi's messages carry no id, so the item id is the message's position. That is stable while
 * history only grows, which is the case for a live session; a compaction rewrites the array and
 * therefore renumbers, and the snapshot that carries the renumbering is the client's cue to
 * replace its transcript wholesale — snapshots are authoritative, which is the model the wire's
 * own `TranscriptProgress` comment states.
 */

import type {
	AssistantTranscriptItem,
	JsonValue,
	ToolTranscriptItem,
	TranscriptItem,
	Usage,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";

type UserContent = UserTranscriptItem["content"][number];
type AssistantContent = AssistantTranscriptItem["content"][number];
type ToolContent = ToolTranscriptItem["content"][number];

interface SourceUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning?: number | undefined;
	readonly totalTokens: number;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}

type SourceContent =
	| {readonly type: "text"; readonly text: string}
	| {readonly type: "thinking"; readonly thinking: string; readonly redacted?: boolean | undefined}
	| {readonly type: "image"; readonly data: string; readonly mimeType: string}
	| {
			readonly type: "toolCall";
			readonly id: string;
			readonly name: string;
			readonly arguments: Record<string, unknown>;
	  };

export type SourceMessage =
	| {
			readonly role: "user";
			readonly content: string | ReadonlyArray<SourceContent>;
			readonly timestamp: number;
	  }
	| {
			readonly role: "assistant";
			readonly content: ReadonlyArray<SourceContent>;
			readonly provider: string;
			readonly model: string;
			readonly responseModel?: string | undefined;
			readonly usage?: SourceUsage | undefined;
			readonly stopReason: string;
			readonly errorMessage?: string | undefined;
			readonly timestamp: number;
	  }
	| {
			readonly role: "toolResult";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly content: ReadonlyArray<SourceContent>;
			readonly isError: boolean;
			readonly usage?: SourceUsage | undefined;
			readonly timestamp: number;
	  };

export const projectUsage = (usage: SourceUsage): Usage => ({
	input: usage.input,
	output: usage.output,
	cacheRead: usage.cacheRead,
	cacheWrite: usage.cacheWrite,
	...(usage.reasoning === undefined ? {} : {reasoning: usage.reasoning}),
	totalTokens: usage.totalTokens,
	cost: {
		input: usage.cost.input,
		output: usage.cost.output,
		cacheRead: usage.cost.cacheRead,
		cacheWrite: usage.cost.cacheWrite,
		total: usage.cost.total,
	},
});

/** Text and image are the only content a user or a tool result may carry on the wire. */
const textOrImage = (parts: ReadonlyArray<SourceContent>): Array<UserContent & ToolContent> => {
	const out: Array<UserContent & ToolContent> = [];
	for (const part of parts) {
		if (part.type === "text") out.push({type: "text", text: part.text});
		else if (part.type === "image")
			out.push({type: "image", data: part.data, mimeType: part.mimeType});
	}
	return out;
};

const assistantContent = (parts: ReadonlyArray<SourceContent>): Array<AssistantContent> => {
	const out: Array<AssistantContent> = [];
	for (const part of parts) {
		if (part.type === "text") out.push({type: "text", text: part.text});
		else if (part.type === "thinking") {
			out.push({
				type: "thinking",
				thinking: part.thinking,
				...(part.redacted === undefined ? {} : {redacted: part.redacted}),
			});
		} else if (part.type === "toolCall") {
			out.push({
				type: "toolCall",
				toolCallId: part.id,
				toolName: part.name,
				input: part.arguments as JsonValue,
			});
		}
	}
	return out;
};

interface AssistantStatus {
	readonly status: "streaming" | "complete" | "error" | "aborted";
	readonly stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
	readonly errorMessage?: string;
}

const assistantStatus = (stopReason: string, errorMessage: string | undefined): AssistantStatus => {
	switch (stopReason) {
		case "stop":
		case "length":
		case "toolUse":
			return {status: "complete", stopReason};
		case "error":
			return {
				status: "error",
				stopReason: "error",
				...(errorMessage === undefined ? {} : {errorMessage}),
			};
		case "aborted":
			return {
				status: "aborted",
				stopReason: "aborted",
				...(errorMessage === undefined ? {} : {errorMessage}),
			};
		default:
			return {status: "streaming"};
	}
};

/**
 * A tool result names its call but not its input, so the input is read back off the assistant
 * turn that made the call. An orphan result — the call was compacted away — gets a null input
 * rather than being dropped, because dropping it would leave the client a shorter transcript than
 * the session has.
 */
export const projectTranscript = (
	messages: ReadonlyArray<SourceMessage>,
): ReadonlyArray<TranscriptItem> => {
	const toolInputs = new Map<string, Record<string, unknown>>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const content of message.content) {
			if (content.type === "toolCall") toolInputs.set(content.id, content.arguments);
		}
	}

	const items: TranscriptItem[] = [];
	messages.forEach((message, index) => {
		const id = `item-${index}`;
		if (message.role === "user") {
			const content: Array<UserContent> =
				typeof message.content === "string"
					? [{type: "text", text: message.content}]
					: textOrImage(message.content);
			items.push({id, role: "user", content, timestamp: message.timestamp});
			return;
		}

		if (message.role === "assistant") {
			items.push({
				id,
				role: "assistant",
				content: assistantContent(message.content),
				model: {provider: message.provider, id: message.model},
				...(message.responseModel === undefined ? {} : {responseModel: message.responseModel}),
				...(message.usage === undefined ? {} : {usage: projectUsage(message.usage)}),
				timestamp: message.timestamp,
				...assistantStatus(message.stopReason, message.errorMessage),
			} as TranscriptItem);
			return;
		}

		if (message.role === "toolResult") {
			items.push({
				id,
				role: "tool",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				input: (toolInputs.get(message.toolCallId) ?? null) as JsonValue,
				content: textOrImage(message.content),
				...(message.usage === undefined ? {} : {usage: projectUsage(message.usage)}),
				timestamp: message.timestamp,
				...(message.isError
					? {status: "error" as const, isError: true as const}
					: {status: "complete" as const, isError: false as const}),
			});
		}
	});
	return items;
};
