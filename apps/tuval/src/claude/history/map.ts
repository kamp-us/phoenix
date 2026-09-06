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

import type {AgentEvent} from "../../ai-agent/events.ts";
import {boundToolOutput} from "../../ai-agent/history/index.ts";
import type {CommandRef, ItemId, JsonValue, TranscriptItem} from "../../ai-agent/ports/index.ts";
import {
	isRecord,
	outputOf,
	parentToolUseIdOf,
	type ThinkingPart,
	textOf,
	thinkingOf,
	timestampOf,
	toolResultsOf,
	toolUsesOf,
} from "./blocks.ts";

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
	/** The subagent-spawning call this one ran inside, or `null` for one the agent made itself. */
	readonly parentId: string | null;
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

/** What a withheld reasoning block reads as. The row exists so the turn does not look empty. */
const WITHHELD_THINKING = "(the provider withheld this reasoning)";

const thinkingTextOf = (parts: ReadonlyArray<ThinkingPart>): string =>
	parts.map((part) => (part.kind === "text" ? part.text : WITHHELD_THINKING)).join("\n");

/**
 * A turn's assistant frame: its reasoning, then its text as one item, then one `running` row per
 * tool call it opened.
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
	const thinking = thinkingOf(body);
	if (thinking.length > 0) {
		// Suffixed rather than the frame's own uuid, because one frame carrying both a thinking block
		// and text is two rows, and two rows sharing an id would fold into one.
		events.push(
			item({
				kind: "thinking",
				id: itemId(`${id}:thinking`),
				timestamp: at,
				text: thinkingTextOf(thinking),
			}),
		);
	}
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
	const parentId = parentToolUseIdOf(message);
	let toolCalls = mapping.toolCalls;
	for (const use of toolUsesOf(body)) {
		toolCalls = withCall(toolCalls, use.id, {name: use.name, input: use.input, at, parentId});
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
						...(parentId === null ? {} : {parentId: itemId(parentId)}),
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
	const framedParentId = parentToolUseIdOf(message);
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
		// The call that opened the row is authoritative — the row must not change parent when it
		// settles — and this frame's own field is the fallback, so a result arriving on a subagent
		// frame is still marked when the call it answers was opened without one.
		const parentId = call.parentId ?? framedParentId;
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
						...(parentId === null ? {} : {parentId: itemId(parentId)}),
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

/**
 * `init` is where a session says which model it is, and the only place it ever says so.
 *
 * It carries no phase. `init` is "session metadata the CLI emits at the start of each turn"
 * (`sdk.d.ts`), so a `ready` here fires mid-turn and never at a turn's end — the binding that left
 * the core at `prompting` after every reply (#7963). Where a turn ends is the layer's to say, off
 * the `result` message the SDK calls the turn-complete signal.
 */
export const initEvents = (message: unknown, mapping: Mapping): MappingStep => {
	if (!isRecord(message)) return skipMessage(mapping);
	const model = typeof message.model === "string" ? message.model : mapping.model;
	return {
		mapping: {...mapping, model},
		events: [{kind: "usage", model, inputTokens: 0, outputTokens: 0, cost: 0}],
	};
};

/**
 * `SlashCommand` rows as the interface's backend-blind `CommandRef`. A row with no usable `name` is
 * dropped rather than taking the whole push down: the composer would render a bare `/` for it.
 */
export const commandsOf = (value: unknown): ReadonlyArray<CommandRef> => {
	if (!Array.isArray(value)) return [];
	const rows: Array<CommandRef> = [];
	for (const row of value) {
		if (!isRecord(row)) continue;
		const name = typeof row.name === "string" ? row.name : "";
		if (name.length === 0) continue;
		rows.push({
			name,
			...(typeof row.description === "string" && row.description.length > 0
				? {description: row.description}
				: {}),
			...(typeof row.argumentHint === "string" && row.argumentHint.length > 0
				? {argumentHint: row.argumentHint}
				: {}),
		});
	}
	return rows;
};

/**
 * The SDK's mid-session command push, which carries the whole list — its own docstring tells clients
 * to replace their cached one — so this emits the catalog and the fold replaces on it (#8060).
 */
export const commandsChangedEvents = (message: unknown, mapping: Mapping): MappingStep =>
	isRecord(message)
		? {mapping, events: [{kind: "commands", available: commandsOf(message.commands)}]}
		: skipMessage(mapping);

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

const compactionTextOf = (metadata: unknown): string => {
	if (!isRecord(metadata)) return "context compacted";
	const trigger =
		metadata.trigger === "auto" || metadata.trigger === "manual" ? metadata.trigger : null;
	const lead = trigger === null ? "context compacted" : `context compacted (${trigger})`;
	const before = typeof metadata.pre_tokens === "number" ? metadata.pre_tokens : null;
	if (before === null) return lead;
	const after = typeof metadata.post_tokens === "number" ? metadata.post_tokens : null;
	return after === null
		? `${lead}: ${before} tokens before`
		: `${lead}: ${before} tokens before, ${after} after`;
};

/**
 * The session compacted its context here.
 *
 * The frame carries no summary text and no clock of its own — `SDKCompactBoundaryMessage` is
 * `compact_metadata`, `uuid` and `session_id` and nothing else (`sdk.d.ts`, 0.3.259) — so the
 * marker's line is built from the trigger and the token counts, and its timestamp is the caller's.
 */
export const compactBoundaryEvents = (
	message: unknown,
	mapping: Mapping,
	options: MappingOptions,
): MappingStep => {
	if (!isRecord(message)) return skipMessage(mapping);
	const at = timestampOf(message, options.at);
	const id = typeof message.uuid === "string" ? message.uuid : `compaction-${at}`;
	return {
		mapping,
		events: [
			item({
				kind: "compaction",
				id: itemId(id),
				timestamp: at,
				text: compactionTextOf(message.compact_metadata),
			}),
		],
	};
};

/** How much of a notice's own prose rides the summary line before the rest folds into `detail`. */
const NOTICE_SUMMARY_LIMIT = 200;

/** The keys every frame carries; what is left is the notice's own payload, whatever its subtype. */
const noticeEnvelope: ReadonlySet<string> = new Set([
	"type",
	"subtype",
	"uuid",
	"session_id",
	"parent_tool_use_id",
	"timestamp",
]);

const noticeNameOf = (message: Record<string, unknown>): string => {
	const raw =
		typeof message.subtype === "string" && message.subtype.length > 0
			? message.subtype
			: typeof message.type === "string" && message.type.length > 0
				? message.type
				: "notice";
	return raw.replaceAll("_", " ");
};

const noticeProseOf = (message: Record<string, unknown>): string => {
	for (const field of ["content", "text"]) {
		const value = message[field];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return "";
};

const noticeDetailOf = (message: Record<string, unknown>): string => {
	const payload = Object.fromEntries(
		Object.entries(message).filter(([key]) => !noticeEnvelope.has(key)),
	);
	return Object.keys(payload).length === 0 ? "" : JSON.stringify(payload, null, 2);
};

/**
 * One backend notice — every `system` subtype this mapping has no row of its own for, plus
 * `rate_limit_event` — as the port's collapsed session item.
 *
 * Read shape-blind on purpose: the SDK names some fifteen such subtypes at 0.3.259 and adds more
 * each release, so this takes the frame's own name for the line, its prose when it carries any,
 * and folds everything the envelope did not claim into `detail`. A per-subtype arm here would be
 * fifteen arms none of which a golden capture backs.
 */
export const systemNoticeEvents = (
	message: unknown,
	mapping: Mapping,
	options: MappingOptions,
): MappingStep => {
	if (!isRecord(message)) return skipMessage(mapping);
	const at = timestampOf(message, options.at);
	const id = typeof message.uuid === "string" ? message.uuid : `notice-${at}`;
	const name = noticeNameOf(message);
	const prose = noticeProseOf(message);
	const summary =
		prose.length === 0
			? name
			: `${name}: ${prose.length > NOTICE_SUMMARY_LIMIT ? `${prose.slice(0, NOTICE_SUMMARY_LIMIT)}…` : prose}`;
	const detail = noticeDetailOf(message);
	return {
		mapping,
		events: [
			item({
				kind: "system",
				id: itemId(id),
				timestamp: at,
				text: summary,
				...(detail.length === 0 ? {} : {detail}),
			}),
		],
	};
};
