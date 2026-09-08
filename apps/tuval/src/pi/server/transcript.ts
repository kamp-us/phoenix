/**
 * Pi's in-memory `AgentMessage[]` → the wire's `TranscriptItem[]`.
 *
 * Pi's provider content is projected into Tuval's owned vocabulary before the protocol-8 codec
 * carries it as an opaque payload; see .patterns/owned-wire-vocabulary.md.
 *
 * Pi's messages carry no id, so the item id is the message's position. That is stable while
 * history only grows, which is the case for a live session; a compaction rewrites the array and
 * therefore renumbers, and a renumbering is exactly the case `../wire/delta.ts` refuses to patch:
 * the ids stop extending the last ones, so the viewer is sent a whole snapshot and replaces its
 * transcript wholesale.
 *
 * An in-flight message is projected at the position it will land at, which is why it is passed as
 * one more message rather than handled apart: Pi pushes the finished message onto `messages` on
 * `message_end` (`pi-agent-core` `dist/agent.js:387-388`), so the next free index is the index it
 * takes, and every snapshot of a growing reply supersedes one item instead of appending a row.
 */

import {compactionId} from "../wire/compaction.ts";
import type {
	AssistantTranscriptItem,
	JsonValue,
	ToolTranscriptItem,
	TranscriptItem,
	Usage,
	UserTranscriptItem,
} from "../wire/index.ts";

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
			readonly role: "compactionSummary";
			readonly summary: string;
			readonly timestamp: number;
	  }
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

/**
 * The status of a reply this host was handed as the one still being written.
 *
 * Not read off `stopReason`, because that field is the provider's and it settles before the stream
 * does: the OpenAI-Responses adapter assigns `output.stopReason = "stop"` the moment a `message`
 * item reports `phase: "final_answer"`, on the same live object every later delta mutates
 * (`@earendil-works/pi-ai` `dist/api/openai-responses-shared.js:324-327`, and `output` is what each
 * `partial` carries). Every delta after that point would project as a finished reply — unmarked,
 * so `checkpointWorthy` saves a half-written answer once per delta (#8390, which is #8160's own
 * no-go). Being handed the message at all is the stronger fact: `AgentState.streamingMessage` is
 * set from `message_start` and cleared at `message_end` (`pi-agent-core` `dist/agent.js:382-390`),
 * so a message reaching here is mid-flight whatever its `stopReason` says.
 */
const IN_FLIGHT: AssistantStatus = {status: "streaming"};

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
 *
 * `streaming` is the reply still being written, projected as the last item under `status:
 * "streaming"` — the marker that tells a client this text is not the whole reply, and the one that
 * keeps it out of the store. That last slot is the only thing that decides the marker; see
 * `IN_FLIGHT` for why the message's own stop reason cannot.
 */
export const projectTranscript = (
	messages: ReadonlyArray<SourceMessage>,
	streaming?: SourceMessage | undefined,
): ReadonlyArray<TranscriptItem> => {
	const all = streaming === undefined ? messages : [...messages, streaming];
	const inFlight = streaming === undefined ? -1 : all.length - 1;
	const toolInputs = new Map<string, Record<string, unknown>>();
	for (const message of all) {
		if (message.role !== "assistant") continue;
		for (const content of message.content) {
			if (content.type === "toolCall") toolInputs.set(content.id, content.arguments);
		}
	}

	const items: TranscriptItem[] = [];
	all.forEach((message, index) => {
		const id = `item-${index}`;
		if (message.role === "compactionSummary") {
			items.push({
				id: compactionId(index),
				role: "compaction",
				content: [{type: "text", text: message.summary}],
				timestamp: message.timestamp,
			});
			return;
		}
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
				...(index === inFlight
					? IN_FLIGHT
					: assistantStatus(message.stopReason, message.errorMessage)),
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
