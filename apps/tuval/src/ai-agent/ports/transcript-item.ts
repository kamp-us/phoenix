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
	/**
	 * The id of the tool call this item ran *inside*, when a backend nests calls — an agent-spawning
	 * tool whose worker prompts, reasons and calls tools of its own. Absent means the item is the
	 * agent's own, which is every item a backend with no nesting concept ever emits.
	 *
	 * On the base rather than on the tool kind alone: a nested worker's prose is as much the worker's
	 * as its calls are, and a window handed the tag on calls only cannot tell a worker's reply or
	 * reasoning from the agent's own.
	 */
	readonly parentId?: ItemId;
}

/**
 * `local` marks a turn the core recorded when the operator sent it, before any layer confirmed it.
 * The flag is gone the moment the layer echoes the turn back, because the echo replaces the item.
 */
export interface UserItem extends ItemBase {
	readonly kind: "user";
	readonly text: string;
	readonly local?: boolean;
}

/**
 * `interrupted` marks a turn the operator cut short; the resend is a fresh prompt, not a retry.
 *
 * `partial` marks text still being written. A backend re-upserts this same id as the reply grows
 * and leaves the marker off the last upsert, so absent means final and a reader needs no second
 * field to tell a finished reply from one mid-flight. Nothing about which backend is writing
 * reaches the flag: the window learns "still growing" once, for every agent program (#8142).
 */
export interface AssistantItem extends ItemBase {
	readonly kind: "assistant";
	readonly text: string;
	readonly interrupted?: boolean;
	readonly partial?: boolean;
}

export interface ToolItem extends ItemBase {
	readonly kind: "tool";
	readonly name: string;
	readonly input: JsonValue;
	readonly result: ToolResult;
	readonly status: ToolStatus;
}

/**
 * The agent's reasoning for one turn, as content and nothing else.
 *
 * Model-blind like every other item: no provider signature, no redaction flag, no effort level.
 * `ports/thinking.ts` is the effort-level *control* and has nothing to do with this row.
 */
export interface ThinkingItem extends ItemBase {
	readonly kind: "thinking";
	readonly text: string;
}

/**
 * The session compacted its context here, and `text` is the line the marker is labelled with.
 *
 * Its own kind rather than a `SystemItem` so a window can draw a boundary where the earlier turns
 * went, instead of one more line of session prose the reader scrolls past.
 */
export interface CompactionItem extends ItemBase {
	readonly kind: "compaction";
	readonly text: string;
}

/**
 * One backend notice, collapsed: `text` is the line always shown, `detail` the body a window may
 * fold away.
 *
 * Every notice a backend raises — status, a hook firing or failing, a local command's output, a
 * refusal, a rate limit — lands in this one shape. There is deliberately no field naming which of
 * those it was: a per-subtype field would put the backend's own vocabulary on the port, and the
 * SDK alone has some fifteen subtypes that would each want one.
 */
export interface SystemItem extends ItemBase {
	readonly kind: "system";
	readonly text: string;
	readonly detail?: string;
}

export type TranscriptItem =
	| UserItem
	| AssistantItem
	| ToolItem
	| SystemItem
	| ThinkingItem
	| CompactionItem;

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

/** An absent flag and a `false` one say the same thing; anything else is not a flag at all. */
const isOptionalFlag = (value: unknown): boolean =>
	value === undefined || typeof value === "boolean";

const isOptionalId = (value: unknown): boolean => value === undefined || isId(value);

export const isNonNegativeInteger = (value: unknown): boolean =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;

const isToolResult = (value: unknown): value is ToolResult =>
	Predicate.isObject(value) &&
	typeof value.text === "string" &&
	Predicate.isObject(value.omitted) &&
	isNonNegativeInteger(value.omitted.bytes) &&
	byteLength(value.text) <= TOOL_RESULT_BYTE_LIMIT;

const statuses: ReadonlySet<string> = new Set<ToolStatus>(["running", "ok", "error"]);

/**
 * The port predicate for one item: identity, clock, parent tag, kind, and the tool result's own
 * bound. The parent tag is read once ahead of the switch, because every kind may carry one.
 */
export const isTranscriptItem = (value: unknown): value is TranscriptItem => {
	if (
		!Predicate.isObject(value) ||
		!isId(value.id) ||
		!Number.isFinite(value.timestamp) ||
		!isOptionalId(value.parentId)
	)
		return false;
	switch (value.kind) {
		case "user":
			return typeof value.text === "string" && isOptionalFlag(value.local);
		case "system":
			return (
				typeof value.text === "string" &&
				(value.detail === undefined || typeof value.detail === "string")
			);
		case "thinking":
		case "compaction":
			return typeof value.text === "string";
		case "assistant":
			return (
				typeof value.text === "string" &&
				isOptionalFlag(value.interrupted) &&
				isOptionalFlag(value.partial)
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
