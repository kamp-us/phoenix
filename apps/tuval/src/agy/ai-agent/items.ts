/**
 * The port items both agy readers mint: the live stream mapper (`mapper.ts`) and the on-disk
 * transcript reader (`transcript.ts`).
 *
 * Two sources, one set of constructors, on purpose. agy's live wire and its `transcript.jsonl` are
 * different schemas — `step_type` there, `source`/`type` here — but they project onto the same
 * `TranscriptItem` union, and the projection is where the bounds live: the `boundToolResult` cut on
 * every tool row and the `ERROR`/`DONE` status read. A second copy of either would be a second
 * place for the window's per-item byte bound to drift out of agreement with itself.
 */

import {
	type AssistantItem,
	boundToolResult,
	type ItemId,
	type JsonValue,
	type SystemItem,
	type ToolItem,
	type ToolStatus,
	type UserItem,
} from "../../ai-agent/ports/index.ts";

/** `ItemId` is an opaque brand, minted here so no call site writes its own cast. */
export const itemId = (value: string): ItemId => value as ItemId;

export const userItem = (id: string, timestamp: number, text: string): UserItem => ({
	kind: "user",
	id: itemId(id),
	timestamp,
	text,
});

export const assistantItem = (id: string, timestamp: number, text: string): AssistantItem => ({
	kind: "assistant",
	id: itemId(id),
	timestamp,
	text,
});

export const systemItem = (id: string, timestamp: number, text: string): SystemItem => ({
	kind: "system",
	id: itemId(id),
	timestamp,
	text,
});

export interface ToolFields {
	readonly id: string;
	readonly timestamp: number;
	readonly name: string;
	readonly input: JsonValue;
	/** Raw and uncut: the bound is this constructor's, so no caller can mint an unbounded row. */
	readonly result: string;
	readonly status: ToolStatus;
}

export const toolItem = (fields: ToolFields): ToolItem => ({
	kind: "tool",
	id: itemId(fields.id),
	timestamp: fields.timestamp,
	name: fields.name,
	input: fields.input,
	result: boundToolResult(fields.result),
	status: fields.status,
});

/**
 * agy names a step's outcome the same way in both places — `ERROR`, `DONE`, and anything else is
 * still in flight. Read as an open string for the reason `wire.ts` gives: the enum is provably open
 * and neither surface carries a version to branch on.
 */
export const toolStatusOf = (state: string): ToolStatus => {
	if (state === "ERROR") return "error";
	return state === "DONE" ? "ok" : "running";
};
