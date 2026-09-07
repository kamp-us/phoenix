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
 * `init`. A streamed reply is the third: its deltas each carry a fresh uuid, so the turn's stable id
 * and the text so far have to survive from the `message_start` that opened it.
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

/**
 * The reply a `stream_event` run is still writing.
 *
 * `id` is the `msg_*` the wrapped `message_start` announced, and it is the only id on this path
 * that survives a whole turn: `SDKPartialAssistantMessage.uuid` is the *frame's*, fresh per delta
 * (`sdk.d.ts`), so keying a partial on it would append a row per delta. Every `assistant` frame of
 * the turn carries the same `message.id`, which is what lets their text land on this row instead of
 * beside it — and there is one such frame *per completed content block*, not one per turn
 * (`sdk.d.ts`, `SDKAssistantMessage`), so a thinking block's frame arrives before the answer has
 * streamed a word. The reply therefore outlives them all and closes on the end of the stream.
 *
 * `at` is the turn's own clock, held so the row does not jump when it settles — the same reason
 * `ToolCall` holds one.
 */
export interface PartialReply {
	readonly id: string;
	readonly text: string;
	readonly at: number;
}

export interface Mapping {
	/** The model `init` named, which is the only place a Claude session says it. */
	readonly model: string;
	/** Open tool calls by `tool_use` block id. */
	readonly toolCalls: ReadonlyMap<string, ToolCall>;
	/** The reply the deltas are growing, or `null` when no turn is streaming. */
	readonly partial: PartialReply | null;
	/**
	 * The reply whose stream has closed, kept so a frame still naming that `msg_*` finds its row.
	 * Dropping the id at the close is what let a late frame mint a second copy of one answer, keyed
	 * on the frame's own uuid and appended below whatever arrived in between (#8366).
	 */
	readonly settled: PartialReply | null;
	/** How many messages this mapping had nothing to say about. */
	readonly skipped: number;
}

export const emptyMapping: Mapping = {
	model: "",
	toolCalls: new Map(),
	partial: null,
	settled: null,
	skipped: 0,
};

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
 *
 * While a reply of this same turn is streaming, the frame delivers one completed content block and
 * nothing more: it feeds its text into the open reply and emits no row of its own, because the
 * deltas are already drawing that row and the stream's own end is what settles it. A frame is the
 * whole turn — and so emits the row — only when nothing is streaming, when it carries a real
 * `stop_reason`, or when it was aborted.
 */
export const assistantEvents = (
	message: unknown,
	mapping: Mapping,
	options: MappingOptions,
): MappingStep => {
	if (!isRecord(message)) return skipMessage(mapping);
	const body = message.message;
	const frameText = textOf(body);
	const interrupted = message.aborted === true;
	// The deltas of this same reply, when the run streamed them: this frame's `message.id` is the
	// `msg_*` the `message_start` announced, so the row lands on the partials rather than beside
	// them, at the clock they were written under. The stream having already closed changes nothing
	// about where the frame belongs, so a match against the settled reply routes it the same way.
	const open = replyOf(body, mapping.partial);
	const closed = open === null ? replyOf(body, mapping.settled) : null;
	const row = open ?? closed;
	const at = row === null ? timestampOf(message, options.at) : row.at;
	const id = row?.id ?? (typeof message.uuid === "string" ? message.uuid : `assistant-${at}`);
	const reply = row === null ? null : grown(row, addedTextOf(row.text, frameText));
	const ends = interrupted || stopReasonOf(body) !== null;
	const settles = open === null || ends;
	const text = reply === null ? frameText : reply.text;
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
	if (settles && (text.length > 0 || interrupted)) {
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
	// Only a frame of the open reply's own turn touches it. Any other assistant frame can arrive
	// mid-stream — a subagent's does — and closing on that one would freeze the reply mid-word.
	return {
		mapping: {
			...mapping,
			toolCalls,
			partial: open === null ? mapping.partial : ends ? null : reply,
			// A row this frame leaves settled stays reachable, so a further frame of the same turn —
			// a trailing content block — still lands on it rather than beside it.
			settled: reply === null || (open !== null && !ends) ? mapping.settled : reply,
		},
		events,
	};
};

/** The reply this frame belongs to, or `null` when it is not a frame of that reply's turn. */
const replyOf = (body: unknown, reply: PartialReply | null): PartialReply | null => {
	if (reply === null || !isRecord(body)) return null;
	return body.id === reply.id ? reply : null;
};

/**
 * The turn's stop reason, which a per-block frame of a streamed reply never carries: on those
 * "message.stop_reason is null … the turn's stop reason and total usage arrive on the result
 * message" (`sdk.d.ts` 0.3.259, `SDKAssistantMessage`). So a real one marks the whole message.
 */
const stopReasonOf = (body: unknown): string | null => {
	if (!isRecord(body)) return null;
	return typeof body.stop_reason === "string" ? body.stop_reason : null;
};

/**
 * What a frame's text adds to the reply the deltas are growing — usually nothing, because those
 * deltas already wrote this block. It matters for a block whose deltas never reached this mapping
 * (a reader that joined mid-turn, a delta kind this mapping drops): the frame is then the only
 * place that text exists, and it joins on a newline the way `textOf` joins a body's blocks.
 */
const addedTextOf = (sofar: string, frameText: string): string => {
	if (frameText.length === 0 || sofar.endsWith(frameText)) return "";
	return sofar.length === 0 ? frameText : `\n${frameText}`;
};

const textDeltaOf = (event: Record<string, unknown>): string => {
	const delta = event.delta;
	if (!isRecord(delta) || delta.type !== "text_delta") return "";
	return typeof delta.text === "string" ? delta.text : "";
};

/** The `message_delta` that announces the turn's stop reason, which ends the stream with it. */
const stopsStream = (event: Record<string, unknown>): boolean =>
	event.type === "message_delta" && stopReasonOf(event.delta) !== null;

const grown = (open: PartialReply, text: string): PartialReply => ({
	...open,
	text: open.text + text,
});

/**
 * One streaming frame of the reply being written, as a re-upsert of the one assistant row.
 *
 * The turn's `message_start` is what opens the row's identity, and nothing else can: every other
 * frame here carries only its own per-delta `uuid`. So a delta arriving with no open reply is
 * counted rather than given an id of its own — that happens to a reader that joined the stream
 * mid-turn, and inventing a key for it would put a second row on screen for one answer.
 *
 * A `thinking_delta` is not assistant text. The reasoning a turn streams is the `thinking` item
 * kind's, never folded into the reply, so it leaves this row where it was.
 *
 * The end of the stream is what settles the row: `message_stop`, or the `message_delta` carrying
 * the turn's `stop_reason`. Nothing earlier can, because the turn emits one `assistant` frame per
 * completed content block and the first of those can be a thinking block.
 */
export const partialReplyEvents = (
	message: unknown,
	mapping: Mapping,
	options: MappingOptions,
): MappingStep => {
	if (!isRecord(message)) return skipMessage(mapping);
	const event = message.event;
	if (!isRecord(event)) return skipMessage(mapping);
	if (event.type === "message_start") {
		const body = event.message;
		const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
		if (id.length === 0) return skipMessage(mapping);
		const at = timestampOf(message, options.at);
		return {mapping: {...mapping, partial: {id, text: "", at}}, events: []};
	}
	const open = mapping.partial;
	if (open === null) return skipMessage(mapping);
	if (event.type === "message_stop" || stopsStream(event)) {
		return {
			mapping: {...mapping, partial: null, settled: open},
			events:
				open.text.length === 0
					? []
					: [
							item({
								kind: "assistant",
								id: itemId(open.id),
								timestamp: open.at,
								text: open.text,
							}),
						],
		};
	}
	if (event.type === "content_block_start") {
		const block = event.content_block;
		if (!isRecord(block) || block.type !== "text") return skipMessage(mapping);
		// `textOf` joins a body's text blocks on a newline, so the growing row joins them the same
		// way: without this the last upsert would reflow text the operator was already reading.
		const lead = open.text.length === 0 ? "" : "\n";
		const opening = typeof block.text === "string" ? block.text : "";
		return {mapping: {...mapping, partial: grown(open, lead + opening)}, events: []};
	}
	if (event.type !== "content_block_delta") return skipMessage(mapping);
	const text = textDeltaOf(event);
	if (text.length === 0) return skipMessage(mapping);
	const partial = grown(open, text);
	return {
		mapping: {...mapping, partial},
		events: [
			item({
				kind: "assistant",
				id: itemId(partial.id),
				timestamp: partial.at,
				text: partial.text,
				partial: true,
			}),
		],
	};
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
	const id = typeof message.uuid === "string" ? message.uuid : `result-${at}`;
	const failed = message.is_error === true || message.subtype !== "success";
	if (failed) {
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
				turn: id,
				model: mapping.model,
				inputTokens: tokensOf(message.usage, "input_tokens"),
				outputTokens: tokensOf(message.usage, "output_tokens"),
				cost,
			},
		],
	};
};

/**
 * The turn id `init`'s announcement rides under. It is not a turn: `init` fires at the start of
 * every turn and carries no spend, so one reserved key keeps the session's ledger from growing an
 * empty entry per turn while the model it names still lands (`core/fold.ts`, `addUsage`).
 */
const MODEL_ANNOUNCEMENT = "claude:model-announcement";

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
		events: [
			{kind: "usage", turn: MODEL_ANNOUNCEMENT, model, inputTokens: 0, outputTokens: 0, cost: 0},
		],
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
