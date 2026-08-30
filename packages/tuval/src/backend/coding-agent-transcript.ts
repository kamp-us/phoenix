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

type AssistantTranscriptItem = Extract<TranscriptItem, {role: "assistant"}>;
type ToolTranscriptItem = Extract<TranscriptItem, {role: "tool"}>;
type NonToolTranscriptItem = Exclude<TranscriptItem, {role: "tool"}>;

type NonEmptyArray<A> = readonly [A, ...Array<A>];

type TranscriptCandidate =
	| {
			readonly _tag: "single";
			readonly start: number;
			readonly end: number;
			readonly item: NonToolTranscriptItem;
	  }
	| {
			readonly _tag: "tool-call";
			readonly start: number;
			readonly end: number;
			readonly call: AssistantTranscriptItem;
	  }
	| {
			readonly _tag: "tool-pair";
			readonly start: number;
			readonly end: number;
			readonly call: AssistantTranscriptItem;
			readonly results: NonEmptyArray<ToolTranscriptItem>;
	  }
	| {
			readonly _tag: "invalid-tool-group";
			readonly start: number;
			readonly end: number;
			readonly items: NonEmptyArray<TranscriptItem>;
	  };

export type TranscriptOmissionReason =
	| "oversized-item"
	| "oversized-tool-pair"
	| "invalid-tool-group";

export interface TranscriptWindowPlan {
	readonly transcript: ReadonlyArray<TranscriptItem>;
	readonly sourceStart: number;
	readonly sourceEnd: number;
	readonly encodedBytes: number;
}

const toolCallIds = (item: AssistantTranscriptItem): ReadonlyArray<string> =>
	item.content.flatMap((part) => (part.type === "toolCall" ? [part.toolCallId] : []));

const candidatesOf = (transcript: ReadonlyArray<TranscriptItem>): Array<TranscriptCandidate> => {
	const candidates: Array<TranscriptCandidate> = [];
	let index = 0;
	while (index < transcript.length) {
		const item = transcript[index];
		if (item === undefined) break;
		if (item.role === "tool") {
			candidates.push({
				_tag: "invalid-tool-group",
				start: index,
				end: index + 1,
				items: [item],
			});
			index += 1;
			continue;
		}
		if (item.role !== "assistant" || toolCallIds(item).length === 0) {
			candidates.push({_tag: "single", start: index, end: index + 1, item});
			index += 1;
			continue;
		}

		const callIds = toolCallIds(item);
		const results: Array<ToolTranscriptItem> = [];
		let end = index + 1;
		while (transcript[end]?.role === "tool") {
			results.push(transcript[end] as ToolTranscriptItem);
			end += 1;
		}
		const resultIds = results.map(({toolCallId}) => toolCallId);
		const validCallIds = new Set(callIds).size === callIds.length;
		const validPair =
			validCallIds &&
			results.length > 0 &&
			resultIds.length === callIds.length &&
			new Set(resultIds).size === resultIds.length &&
			callIds.every((id) => resultIds.includes(id));
		if (validCallIds && results.length === 0) {
			candidates.push({_tag: "tool-call", start: index, end, call: item});
		} else if (validPair) {
			candidates.push({
				_tag: "tool-pair",
				start: index,
				end,
				call: item,
				results: results as [ToolTranscriptItem, ...Array<ToolTranscriptItem>],
			});
		} else {
			candidates.push({
				_tag: "invalid-tool-group",
				start: index,
				end,
				items: transcript.slice(index, end) as [TranscriptItem, ...Array<TranscriptItem>],
			});
		}
		index = end;
	}
	return candidates;
};

const itemsOf = (candidate: TranscriptCandidate): NonEmptyArray<TranscriptItem> => {
	if (candidate._tag === "single") return [candidate.item];
	if (candidate._tag === "tool-call") return [candidate.call];
	if (candidate._tag === "tool-pair") return [candidate.call, ...candidate.results];
	return candidate.items;
};

const encodedBytesOf = (items: ReadonlyArray<TranscriptItem>): number =>
	Buffer.byteLength(JSON.stringify(items), "utf8");

const omissionNotice = (
	reason: TranscriptOmissionReason,
	itemCount: number,
	encodedBytes: number,
): string => {
	if (reason === "oversized-tool-pair") {
		return `${itemCount} iletilik araç çağrısı ve sonucu (${encodedBytes} bayt) pencere sınırını birlikte aştığı için gösterilmedi.`;
	}
	if (reason === "invalid-tool-group") {
		return `${itemCount} iletilik araç etkileşimi eşleşmesi korunamadığı için gösterilmedi (${encodedBytes} bayt).`;
	}
	return `Bu ileti (${encodedBytes} bayt) pencere sınırını aştığı için gösterilmedi.`;
};

export const transcriptOmissionMetadata = (
	item: TranscriptItem,
):
	| {
			readonly sourceStart: number;
			readonly sourceEnd: number;
			readonly omittedItemCount: number;
			readonly omittedByteCount: number;
			readonly reason: TranscriptOmissionReason;
	  }
	| undefined => {
	const match =
		/^tuval-omission:(\d+):(\d+):(\d+):(\d+):(oversized-item|oversized-tool-pair|invalid-tool-group)$/.exec(
			item.id,
		);
	if (match === null) return undefined;
	const [, startText, endText, itemCountText, byteCountText, reason] = match;
	const values = [startText, endText, itemCountText, byteCountText].map(Number);
	if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
	const [sourceStart, sourceEnd, omittedItemCount, omittedByteCount] = values as [
		number,
		number,
		number,
		number,
	];
	if (sourceEnd <= sourceStart || omittedItemCount !== sourceEnd - sourceStart) return undefined;
	return {
		sourceStart,
		sourceEnd,
		omittedItemCount,
		omittedByteCount,
		reason: reason as TranscriptOmissionReason,
	};
};

const omissionOf = (
	candidate: TranscriptCandidate,
	reason: TranscriptOmissionReason,
): TranscriptItem => {
	const original = itemsOf(candidate);
	const encodedBytes = encodedBytesOf(original) - Buffer.byteLength("[]", "utf8");
	return {
		id: `tuval-omission:${candidate.start}:${candidate.end}:${original.length}:${encodedBytes}:${reason}`,
		role: "user",
		content: [{type: "text", text: omissionNotice(reason, original.length, encodedBytes)}],
		timestamp: original[0].timestamp,
	};
};

const outputOf = (candidate: TranscriptCandidate): NonEmptyArray<TranscriptItem> => {
	if (candidate._tag === "invalid-tool-group") {
		return [omissionOf(candidate, "invalid-tool-group")];
	}
	const original = itemsOf(candidate);
	if (
		original.length <= TRANSCRIPT_WINDOW_LIMIT &&
		encodedBytesOf(original) <= TRANSCRIPT_WINDOW_BYTE_LIMIT
	) {
		return original;
	}
	return [
		omissionOf(
			candidate,
			candidate._tag === "tool-pair" ? "oversized-tool-pair" : "oversized-item",
		),
	];
};

export const planTranscriptWindow = (
	transcript: ReadonlyArray<TranscriptItem>,
	before = transcript.length,
): TranscriptWindowPlan => {
	if (!Number.isSafeInteger(before) || before < 0 || before > transcript.length) {
		throw new RangeError("Transcript window boundary is outside the source transcript");
	}
	const candidates = candidatesOf(transcript);
	const boundary = candidates.findIndex(({end}) => end === before);
	if (before !== 0 && boundary < 0) {
		throw new RangeError("Transcript window boundary splits an atomic candidate group");
	}
	let sourceStart = before;
	let output: Array<TranscriptItem> = [];
	for (let index = before === 0 ? -1 : boundary; index >= 0; index -= 1) {
		const candidate = candidates[index];
		if (candidate === undefined) break;
		const candidateOutput = outputOf(candidate);
		const proposed = [...candidateOutput, ...output];
		if (
			proposed.length > TRANSCRIPT_WINDOW_LIMIT ||
			encodedBytesOf(proposed) > TRANSCRIPT_WINDOW_BYTE_LIMIT
		) {
			break;
		}
		output = proposed;
		sourceStart = candidate.start;
	}
	return {
		transcript: output,
		sourceStart,
		sourceEnd: before,
		encodedBytes: encodedBytesOf(output),
	};
};

export const transcriptSourceIndex = (
	sessionId: string,
	item: TranscriptItem,
): number | undefined => {
	const omission = transcriptOmissionMetadata(item);
	if (omission !== undefined) return omission.sourceStart;
	const prefix = `${sessionId}:`;
	if (!item.id.startsWith(prefix)) return undefined;
	const index = Number(item.id.slice(prefix.length));
	return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
};

export const recentTranscriptOf = (
	transcript: ReadonlyArray<TranscriptItem>,
): Array<TranscriptItem> => [...planTranscriptWindow(transcript).transcript];
