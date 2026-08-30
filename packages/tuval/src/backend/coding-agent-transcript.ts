import type {AgentSession} from "@earendil-works/pi-coding-agent";
import type {JsonValue, TranscriptItem} from "@earendil-works/pi-protocol";

export const TRANSCRIPT_WINDOW_LIMIT = 40;
export const TRANSCRIPT_WINDOW_BYTE_LIMIT = 256_000;

export type CodingMessage = AgentSession["messages"][number];
type UserTranscriptContent = Extract<TranscriptItem, {role: "user"}>["content"];
type AssistantTranscriptContent = Extract<TranscriptItem, {role: "assistant"}>["content"];
type ToolTranscriptContent = Extract<TranscriptItem, {role: "tool"}>["content"];

const plainJson = (value: unknown): value is JsonValue => {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(plainJson);
	if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
	return Object.values(value).every(plainJson);
};

const usageOf = (usage: {
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
}) => ({
	input: usage.input,
	output: usage.output,
	cacheRead: usage.cacheRead,
	cacheWrite: usage.cacheWrite,
	...(usage.reasoning === undefined ? {} : {reasoning: usage.reasoning}),
	totalTokens: usage.totalTokens,
	cost: {...usage.cost},
});

const userContentOf = (
	content: string | ReadonlyArray<unknown>,
): UserTranscriptContent | ToolTranscriptContent => {
	if (typeof content === "string") return [{type: "text", text: content}];
	const projected: UserTranscriptContent = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const candidate = part as Record<string, unknown>;
		if (candidate.type === "text" && typeof candidate.text === "string") {
			projected.push({type: "text", text: candidate.text});
		} else if (
			candidate.type === "image" &&
			typeof candidate.data === "string" &&
			typeof candidate.mimeType === "string"
		) {
			projected.push({type: "image", data: candidate.data, mimeType: candidate.mimeType});
		}
	}
	return projected;
};

const assistantContentOf = (content: ReadonlyArray<unknown>): AssistantTranscriptContent => {
	const projected: AssistantTranscriptContent = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const candidate = part as Record<string, unknown>;
		if (candidate.type === "text" && typeof candidate.text === "string") {
			projected.push({type: "text", text: candidate.text});
		} else if (candidate.type === "thinking" && typeof candidate.thinking === "string") {
			projected.push({
				type: "thinking",
				thinking: candidate.thinking,
				...(candidate.redacted === true ? {redacted: true} : {}),
			});
		} else if (
			candidate.type === "toolCall" &&
			typeof candidate.id === "string" &&
			typeof candidate.name === "string" &&
			plainJson(candidate.arguments)
		) {
			projected.push({
				type: "toolCall",
				toolCallId: candidate.id,
				toolName: candidate.name,
				input: candidate.arguments,
			});
		}
	}
	return projected;
};

const toolInputOf = (
	messages: ReadonlyArray<CodingMessage>,
	index: number,
	toolCallId: string,
): {readonly input: JsonValue} => {
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const candidate = messages[cursor];
		if (candidate?.role !== "assistant") continue;
		for (const part of candidate.content) {
			if (part.type === "toolCall" && part.id === toolCallId && plainJson(part.arguments)) {
				return {input: part.arguments};
			}
		}
	}
	return {input: {}};
};

export const transcriptOfMessages = (
	sessionId: string,
	messages: ReadonlyArray<CodingMessage>,
): Array<TranscriptItem> =>
	messages.flatMap((message, index): Array<TranscriptItem> => {
		const id = `${sessionId}:${index}`;
		if (message.role === "user") {
			return [
				{
					id,
					role: "user",
					content: userContentOf(message.content) as UserTranscriptContent,
					timestamp: message.timestamp,
				},
			];
		}
		if (message.role === "assistant") {
			const common = {
				id,
				role: "assistant" as const,
				content: assistantContentOf(message.content),
				model: {provider: message.provider, id: message.model},
				...(message.responseModel === undefined ? {} : {responseModel: message.responseModel}),
				usage: usageOf(message.usage),
				timestamp: message.timestamp,
			};
			if (message.stopReason === "error") {
				return [
					{
						...common,
						status: "error",
						stopReason: "error",
						...(message.errorMessage === undefined ? {} : {errorMessage: message.errorMessage}),
					},
				];
			}
			if (message.stopReason === "aborted") {
				return [
					{
						...common,
						status: "aborted",
						stopReason: "aborted",
						...(message.errorMessage === undefined ? {} : {errorMessage: message.errorMessage}),
					},
				];
			}
			if (
				message.stopReason === "stop" ||
				message.stopReason === "length" ||
				message.stopReason === "toolUse"
			) {
				return [{...common, status: "complete", stopReason: message.stopReason}];
			}
			return [{...common, status: "streaming"}];
		}
		if (message.role === "toolResult") {
			const {input} = toolInputOf(messages, index, message.toolCallId);
			const common = {
				id,
				role: "tool" as const,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				input: plainJson(input) ? input : {},
				content: userContentOf(message.content) as ToolTranscriptContent,
				...(plainJson(message.details) ? {details: message.details} : {}),
				...(message.usage === undefined ? {} : {usage: usageOf(message.usage)}),
				timestamp: message.timestamp,
			};
			return message.isError
				? [{...common, status: "error", isError: true}]
				: [{...common, status: "complete", isError: false}];
		}
		return [];
	});

export const transcriptOf = (session: AgentSession): Array<TranscriptItem> =>
	transcriptOfMessages(session.sessionId, session.messages);

const toolCallIds = (item: TranscriptItem): ReadonlyArray<string> =>
	item.role === "assistant"
		? item.content.flatMap((part) => (part.type === "toolCall" ? [part.toolCallId] : []))
		: [];

const pairedWindowStart = (
	transcript: ReadonlyArray<TranscriptItem>,
	candidateStart: number,
): number => {
	let start = Math.max(0, candidateStart);
	while (transcript[start]?.role === "tool") {
		const tool = transcript[start];
		if (tool?.role !== "tool") break;
		const call = transcript.findLastIndex(
			(item, index) => index < start && toolCallIds(item).includes(tool.toolCallId),
		);
		if (call < 0) break;
		start = call;
	}
	return start;
};

export const boundedWindowStart = (
	transcript: ReadonlyArray<TranscriptItem>,
	before: number,
): number => {
	let start = before;
	let bytes = 0;
	while (start > 0 && before - start < TRANSCRIPT_WINDOW_LIMIT) {
		const nextBytes = Buffer.byteLength(JSON.stringify(transcript[start - 1]), "utf8");
		if (start < before && bytes + nextBytes > TRANSCRIPT_WINDOW_BYTE_LIMIT) break;
		bytes += nextBytes;
		start -= 1;
	}
	return pairedWindowStart(transcript, start);
};

export const recentTranscriptOf = (
	transcript: ReadonlyArray<TranscriptItem>,
): Array<TranscriptItem> => transcript.slice(boundedWindowStart(transcript, transcript.length));
