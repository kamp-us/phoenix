/**
 * The mapping itself: one Claude message in, the agent events it stands for out.
 *
 * Every handler here reads `unknown` rather than an SDK type, because two callers feed them two
 * different wire forms of the same conversation — a live `SDKMessage` off `query()`, and a
 * `SessionMessage` row off `getSessionMessages` whose `message` field the SDK types as `unknown`
 * outright (`sdk.d.ts`). Typing the handlers to one of them would force the other through a cast.
 * The typed entry points are `toAgentEvents` and `toHistoryItems`; this file is what they share.
 *
 * `mapping` is the whole memory this mapping needs. A `tool_result` block names only the id of the
 * call it answers, so the tool's name and input have to survive from the `tool_use` that opened it,
 * and a `result` message reports cost without naming a model, so the model has to survive from
 * `init`.
 */

import type {AgentEvent, Phase} from "../../ai-agent/events.ts";
import {boundToolOutput} from "../../ai-agent/history/index.ts";
import type {ItemId, JsonValue, TranscriptItem} from "../../ai-agent/ports/index.ts";
import {isRecord, outputOf, textOf, timestampOf, toolResultsOf, toolUsesOf} from "./blocks.ts";

/** `ports` mints an `ItemId` through an effect `Schema` brand, and this directory imports no effect. */
const itemId = (value: string): ItemId => value as ItemId;

/**
 * One tool call the transcript has opened and not yet settled. `at` is the call's own clock, kept
 * so the settled row lands at the time of the call rather than of its answer — a transcript read
 * oldest-first has to stay monotonic, and a row that jumped forward when it settled would not.
 */
export interface ToolCall {
	readonly name: string;
	readonly input: JsonValue;
	readonly at: number;
}

export interface Mapping {
	/** The model `init` named, which is the only place a Claude session says it. */
	readonly model: string;
	/** Open tool calls by `tool_use` block id. */
	readonly toolCalls: ReadonlyMap<string, ToolCall>;
	/** How many messages this mapping had nothing to say about. */
	readonly skipped: number;
}

export const emptyMapping: Mapping = {model: "", toolCalls: new Map(), skipped: 0};

export interface MappingOptions {
	/** Epoch milliseconds for any message carrying no timestamp of its own. */
	readonly at: number;
	/** The per-item tool-output bound (#7600). Defaults to `TOOL_RESULT_BYTE_LIMIT`. */
	readonly toolResultLimit?: number;
}

export interface MappingStep {
	readonly mapping: Mapping;
	readonly events: ReadonlyArray<AgentEvent>;
}

const item = (one: TranscriptItem): AgentEvent => ({kind: "item", item: one});

export const skipMessage = (mapping: Mapping): MappingStep => ({
	mapping: {...mapping, skipped: mapping.skipped + 1},
	events: [],
});

const withCall = (
	calls: ReadonlyMap<string, ToolCall>,
	id: string,
	call: ToolCall,
): ReadonlyMap<string, ToolCall> => new Map(calls).set(id, call);

const withoutCall = (
	calls: ReadonlyMap<string, ToolCall>,
	id: string,
): ReadonlyMap<string, ToolCall> => {
	const next = new Map(calls);
	next.delete(id);
	return next;
};

/**
 * A turn's assistant frame: its text as one item, then one `running` row per tool call it opened.
 * `aborted` is the SDK's mark for a message the stream cut mid-word, so it is the transcript's
 * `interrupted` — and an aborted frame with no text still earns its item, because the operator
 * needs to see that the turn was cut rather than nothing at all.
 */
export const assistantEvents = (
	message: unknown,
	mapping: Mapping,
	options: MappingOptions,
): MappingStep => {
	if (!isRecord(message)) return skipMessage(mapping);
	const at = timestampOf(message, options.at);
	const body = message.message;
	const text = textOf(body);
	const interrupted = message.aborted === true;
	const id = typeof message.uuid === "string" ? message.uuid : `assistant-${at}`;
	const events: AgentEvent[] = [];
	if (text.length > 0 || interrupted) {
		events.push(
			item({
				kind: "assistant",
				id: itemId(id),
				timestamp: at,
				text,
				...(interrupted ? {interrupted: true} : {}),
			}),
		);
	}
	let toolCalls = mapping.toolCalls;
	for (const use of toolUsesOf(body)) {
		toolCalls = withCall(toolCalls, use.id, {name: use.name, input: use.input, at});
		events.push(
			item(
				boundToolOutput(
					{
						kind: "tool",
						id: itemId(use.id),
						timestamp: at,
						name: use.name,
						input: use.input,
						status: "running",
						output: "",
					},
					options.toolResultLimit,
				),
			),
		);
	}
	return {mapping: {...mapping, toolCalls}, events};
};

/**
 * A user frame is either the operator's prompt or the results of the calls the last turn opened.
 *
 * A result whose call this mapping never saw is dropped and counted: the item union has no
 * name-less tool row, and inventing one would put a lie on screen. It happens only to a reader
 * that joined the stream between a call and its answer.
 */
export const userEvents = (
	message: unknown,
	mapping: Mapping,
	options: MappingOptions,
): MappingStep => {
	if (!isRecord(message)) return skipMessage(mapping);
	const at = timestampOf(message, options.at);
	const body = message.message;
	const results = toolResultsOf(body);
	if (results.length === 0) {
		const text = textOf(body);
		if (text.length === 0) return skipMessage(mapping);
		const id = typeof message.uuid === "string" ? message.uuid : `user-${at}`;
		return {mapping, events: [item({kind: "user", id: itemId(id), timestamp: at, text})]};
	}
	let toolCalls = mapping.toolCalls;
	let skipped = mapping.skipped;
	const events: AgentEvent[] = [];
	for (const result of results) {
		const call = toolCalls.get(result.toolUseId);
		if (call === undefined) {
			skipped += 1;
			continue;
		}
		toolCalls = withoutCall(toolCalls, result.toolUseId);
		events.push(
			item(
				boundToolOutput(
					{
						kind: "tool",
						id: itemId(result.toolUseId),
						timestamp: call.at,
						name: call.name,
						input: call.input,
						status: result.failed ? "error" : "ok",
						output: result.text.length > 0 ? result.text : outputOf(message.tool_use_result),
					},
					options.toolResultLimit,
				),
			),
		);
	}
	return {mapping: {...mapping, toolCalls, skipped}, events};
};

const errorTextOf = (message: Record<string, unknown>): string => {
	const errors = Array.isArray(message.errors)
		? message.errors.filter((one): one is string => typeof one === "string")
		: [];
	if (errors.length > 0) return errors.join("\n");
	if (typeof message.result === "string" && message.result.length > 0) return message.result;
	return "the session ended without a result";
};

const tokensOf = (usage: unknown, field: string): number => {
	if (!isRecord(usage)) return 0;
	const value = usage[field];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

/**
 * A turn's result. A success is spend and nothing else — the answer's text already arrived as the
 * turn's assistant frame, so re-sending it would double every reply. A failure is the one thing
 * the transcript would otherwise never show, so it lands as a system line.
 */
export const resultEvents = (
	message: unknown,
	mapping: Mapping,
	options: MappingOptions,
): MappingStep => {
	if (!isRecord(message)) return skipMessage(mapping);
	const at = timestampOf(message, options.at);
	const failed = message.is_error === true || message.subtype !== "success";
	if (failed) {
		const id = typeof message.uuid === "string" ? message.uuid : `result-${at}`;
		const subtype = typeof message.subtype === "string" ? message.subtype : "error";
		return {
			mapping,
			events: [
				item({
					kind: "system",
					id: itemId(id),
					timestamp: at,
					text: `${subtype}: ${errorTextOf(message)}`,
				}),
			],
		};
	}
	const cost = typeof message.total_cost_usd === "number" ? message.total_cost_usd : 0;
	return {
		mapping,
		events: [
			{
				kind: "usage",
				model: mapping.model,
				inputTokens: tokensOf(message.usage, "input_tokens"),
				outputTokens: tokensOf(message.usage, "output_tokens"),
				cost,
			},
		],
	};
};

/** `init` is where a session says which model it is, and the only place it ever says so. */
export const initEvents = (message: unknown, mapping: Mapping): MappingStep => {
	if (!isRecord(message)) return skipMessage(mapping);
	const model = typeof message.model === "string" ? message.model : mapping.model;
	const ready: Phase = "ready";
	return {
		mapping: {...mapping, model},
		events: [
			{kind: "phase", phase: ready},
			{kind: "usage", model, inputTokens: 0, outputTokens: 0, cost: 0},
		],
	};
};

/** A denial the operator never got to answer. The line names the tool, which is the whole point. */
export const permissionDeniedEvents = (
	message: unknown,
	mapping: Mapping,
	options: MappingOptions,
): MappingStep => {
	if (!isRecord(message)) return skipMessage(mapping);
	const at = timestampOf(message, options.at);
	const id = typeof message.uuid === "string" ? message.uuid : `denied-${at}`;
	const tool = typeof message.tool_name === "string" ? message.tool_name : "a tool";
	const reason = typeof message.message === "string" ? message.message : "no reason given";
	return {
		mapping,
		events: [
			item({kind: "system", id: itemId(id), timestamp: at, text: `${tool} denied: ${reason}`}),
		],
	};
};
