/**
 * Reading the Agent SDK's content blocks — the one shape in this program nobody here chose.
 *
 * `SDKAssistantMessage.message` is a `BetaMessage` and `SDKUserMessage.message` a `MessageParam`
 * (`sdk.d.ts`, `@anthropic-ai/claude-agent-sdk@0.3.259`), so a message body's `content` is either a
 * bare string or an array of blocks over a union wide enough that narrowing it at each call site
 * would be the whole file. It is narrowed once here, structurally, so every other file in this
 * directory reads named fields.
 *
 * Structural rather than by the SDK's own block types on purpose: the reader must survive a block
 * kind this pin has never seen, and a `default` over a union the SDK widens later is a compile
 * error waiting to happen.
 */

import {isJsonValue, type JsonValue} from "../../ai-agent/ports/index.ts";

/**
 * The one hand-rolled record predicate left under `apps/tuval/src`; every other site reads
 * `Predicate.isObject` off the `effect` pin, whose guidance bans writing this by hand. This
 * directory may not import `effect` at all — `boundary.unit.test.ts` enforces it, so the mapping
 * stays testable without a runtime — so it holds its own copy, defined exactly as
 * `Predicate.isObject` is: arrays excluded (#7764).
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export interface ToolUseBlock {
	readonly id: string;
	readonly name: string;
	readonly input: JsonValue;
}

export interface ToolResultBlock {
	readonly toolUseId: string;
	readonly text: string;
	readonly failed: boolean;
}

const blocksOf = (body: unknown): ReadonlyArray<unknown> => {
	if (!isRecord(body)) return [];
	return Array.isArray(body.content) ? body.content : [];
};

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0;

/**
 * The text a body reads as. A body whose `content` is a bare string is that string; otherwise the
 * `text` blocks in order. They join on a newline because separate blocks are separate paragraphs
 * of one answer, never two halves of a word.
 */
export const textOf = (body: unknown): string => {
	if (!isRecord(body)) return "";
	if (typeof body.content === "string") return body.content;
	return blocksOf(body)
		.filter(isRecord)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
};

export const toolUsesOf = (body: unknown): ReadonlyArray<ToolUseBlock> =>
	blocksOf(body)
		.filter(isRecord)
		.filter(
			(block) =>
				block.type === "tool_use" && isNonEmptyString(block.id) && typeof block.name === "string",
		)
		.map((block) => ({
			id: block.id as string,
			name: block.name as string,
			input: isJsonValue(block.input) ? block.input : null,
		}));

export const toolResultsOf = (body: unknown): ReadonlyArray<ToolResultBlock> =>
	blocksOf(body)
		.filter(isRecord)
		.filter((block) => block.type === "tool_result" && isNonEmptyString(block.tool_use_id))
		.map((block) => ({
			toolUseId: block.tool_use_id as string,
			text: typeof block.content === "string" ? block.content : textOf(block),
			failed: block.is_error === true,
		}));

/**
 * The tool's own Output object, as the fallback when the block the model was shown is empty — a
 * completed backgrounded call is the case that hits it, since its `tool_result` carries a
 * placeholder and the real output rides `tool_use_result` (`sdk.d.ts`, `SDKUserMessage`). Only the
 * shell-shaped `stdout`/`stderr` pair is read: everything else is per-tool and belongs to whoever
 * renders that tool, not to a text transcript.
 */
export const outputOf = (structured: unknown): string => {
	if (!isRecord(structured)) return "";
	const stdout = typeof structured.stdout === "string" ? structured.stdout : "";
	const stderr = typeof structured.stderr === "string" ? structured.stderr : "";
	if (stdout.length > 0 && stderr.length > 0) return `${stdout}\n${stderr}`;
	return stdout.length > 0 ? stdout : stderr;
};

/** Epoch milliseconds off a message's own ISO `timestamp`, or the caller's clock when it has none. */
export const timestampOf = (message: unknown, fallback: number): number => {
	if (!isRecord(message) || typeof message.timestamp !== "string") return fallback;
	const parsed = Date.parse(message.timestamp);
	return Number.isFinite(parsed) ? parsed : fallback;
};
