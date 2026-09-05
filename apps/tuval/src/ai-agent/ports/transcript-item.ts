/**
 * The transcript item union every Tuval AI agent speaks, and the per-item bound on a tool result.
 *
 * Model-blind by construction: no model name, cost, token count, session id, Pi type or SDK type
 * appears here or anywhere else under `ports/`, which is what lets one `ChatWindow` render any
 * agent program. `boundary.unit.test.ts` is the proof.
 */

import {Predicate, Schema} from "effect";

/** A stable per-item identity: an update to a tool row re-sends the same id with a new status. */
export const ItemId = Schema.String.pipe(Schema.brand("tuval/ai-agent/ItemId"));
export type ItemId = typeof ItemId.Type;

/** A tool's input as it crosses the wire: plain JSON, never a backend's own argument type. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<JsonValue>
	| {readonly [key: string]: JsonValue};

/** How many bytes a bound dropped from one tool result. Zero means the result is whole. */
export interface ResultOmission {
	readonly bytes: number;
}

/** A tool result already cut to `TOOL_RESULT_BYTE_LIMIT`, carrying what the cut left out. */
export interface ToolResult {
	readonly text: string;
	readonly omitted: ResultOmission;
}

export type ToolStatus = "running" | "ok" | "error";

interface ItemBase {
	readonly id: ItemId;
	/** Epoch milliseconds. A wall-clock number, so no backend clock type reaches the window. */
	readonly timestamp: number;
}

export interface UserItem extends ItemBase {
	readonly kind: "user";
	readonly text: string;
}

/** `interrupted` marks a turn the operator cut short; the resend is a fresh prompt, not a retry. */
export interface AssistantItem extends ItemBase {
	readonly kind: "assistant";
	readonly text: string;
	readonly interrupted?: boolean;
}

export interface ToolItem extends ItemBase {
	readonly kind: "tool";
	readonly name: string;
	readonly input: JsonValue;
	readonly result: ToolResult;
	readonly status: ToolStatus;
}

export interface SystemItem extends ItemBase {
	readonly kind: "system";
	readonly text: string;
}

export type TranscriptItem = UserItem | AssistantItem | ToolItem | SystemItem;

/** One tool result may spend this many bytes of the window; the rest is omission metadata. */
export const TOOL_RESULT_BYTE_LIMIT = 8_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const byteLength = (text: string): number => encoder.encode(text).length;

/**
 * Cut a raw tool result to `limit` bytes and report the drop. The cut lands on a code-point
 * boundary — a UTF-8 continuation byte is `10xxxxxx`, so walking back off one reaches the start
 * of the character it belongs to and the kept prefix decodes without a replacement character.
 */
export const boundToolResult = (text: string, limit = TOOL_RESULT_BYTE_LIMIT): ToolResult => {
	const bytes = encoder.encode(text);
	if (bytes.length <= limit) {
		return {text, omitted: {bytes: 0}};
	}
	let end = limit;
	while (end > 0) {
		const byte = bytes[end] ?? 0;
		if (byte < 0x80 || byte >= 0xc0) break;
		end -= 1;
	}
	return {text: decoder.decode(bytes.subarray(0, end)), omitted: {bytes: bytes.length - end}};
};

export const isJsonValue = (value: unknown): value is JsonValue => {
	if (value === null) return true;
	const type = typeof value;
	if (type === "boolean" || type === "string") return true;
	if (type === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return Predicate.isObject(value) && Object.values(value).every(isJsonValue);
};

const isId = (value: unknown): value is ItemId => typeof value === "string" && value.length > 0;

export const isNonNegativeInteger = (value: unknown): boolean =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;

const isToolResult = (value: unknown): value is ToolResult =>
	Predicate.isObject(value) &&
	typeof value.text === "string" &&
	Predicate.isObject(value.omitted) &&
	isNonNegativeInteger(value.omitted.bytes) &&
	byteLength(value.text) <= TOOL_RESULT_BYTE_LIMIT;

const statuses: ReadonlySet<string> = new Set<ToolStatus>(["running", "ok", "error"]);

/** The port predicate for one item: identity, clock, kind, and the tool result's own bound. */
export const isTranscriptItem = (value: unknown): value is TranscriptItem => {
	if (!Predicate.isObject(value) || !isId(value.id) || !Number.isFinite(value.timestamp))
		return false;
	switch (value.kind) {
		case "user":
		case "system":
			return typeof value.text === "string";
		case "assistant":
			return (
				typeof value.text === "string" &&
				(value.interrupted === undefined || typeof value.interrupted === "boolean")
			);
		case "tool":
			return (
				typeof value.name === "string" &&
				isJsonValue(value.input) &&
				isToolResult(value.result) &&
				typeof value.status === "string" &&
				statuses.has(value.status)
			);
		default:
			return false;
	}
};

export const isTranscriptItems = (value: unknown): value is ReadonlyArray<TranscriptItem> =>
	Array.isArray(value) && value.every(isTranscriptItem);
