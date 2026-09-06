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
	textOf,
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
 * One text content block of the reply this turn is streaming, and the row it is being written into.
 *
 * `messageId` is the join key, and it is the *API* message id off the wrapped
 * `BetaRawMessageStartEvent` (`@anthropic-ai/sdk` `BetaRawMessageStartEvent.message` is a
 * `BetaMessage`, whose `id` the complete `SDKAssistantMessage.message` repeats). The frame's own
 * `SDKPartialAssistantMessage.uuid` cannot be it: that uuid is fresh per delta (`sdk.d.ts` at
 * `0.3.259`), so a row keyed on it would be a new row per token.
 */
export interface StreamedBlock {
	readonly messageId: string;
	readonly index: number;
	readonly id: string;
	readonly at: number;
	readonly text: string;
	/** The complete assistant frame for this block has landed and superseded the row. */
	readonly claimed: boolean;
}

/**
 * How often a growing reply earns an item event. Deltas arrive per token; every one of them folds
 * into the session state and the whole state is written to the checkpoint store on each fold
 * (`host/actor.ts`), so an unthrottled stream would rewrite the transcript to disk per token.
 *
 * A pure interval read off `MappingOptions.at` rather than a timer: the layer already stamps every
 * message with `Date.now()`, so the coalescing is a fold over values and a test drives it by
 * handing in clocks.
 */
export const STREAM_EMIT_INTERVAL_MS = 120;

export interface Mapping {
	/** The model `init` named, which is the only place a Claude session says it. */
	readonly model: string;
	/** Open tool calls by `tool_use` block id. */
	readonly toolCalls: ReadonlyMap<string, ToolCall>;
	/** How many messages this mapping had nothing to say about. */
	readonly skipped: number;
	/** The API message id the last `message_start` opened; `null` outside a streamed message. */
	readonly streamId: string | null;
	/** The reply's text blocks as they stream, in the order the model opened them. */
	readonly blocks: ReadonlyArray<StreamedBlock>;
	/** When the last partial item event went out, so a burst of deltas costs one event. */
	readonly emittedAt: number;
}

export const emptyMapping: Mapping = {
	model: "",
	toolCalls: new Map(),
	skipped: 0,
	streamId: null,
	blocks: [],
	emittedAt: 0,
};

/** The row one streamed text block is written into. Stable for the life of the block. */
const streamedItemId = (messageId: string, index: number): string => `stream:${messageId}:${index}`;

const streamingItem = (block: StreamedBlock): TranscriptItem => ({
	kind: "assistant",
	id: itemId(block.id),
	timestamp: block.at,
	text: block.text,
	streaming: true,
});

/**
 * The streamed row one complete assistant frame supersedes, or `null`.
 *
 * The frame names its API message id and nothing finer, and one message can stream several text
 * blocks — so the claim is the oldest unclaimed block of *that* message. A frame whose message
 * streamed nothing claims nothing and keeps today's `uuid`-keyed row, which is what a run without
 * `includePartialMessages` is made entirely of.
 */
const claimable = (blocks: ReadonlyArray<StreamedBlock>, messageId: string | null): number =>
	messageId === null
		? -1
		: blocks.findIndex((block) => block.messageId === messageId && !block.claimed);

const claim = (blocks: ReadonlyArray<StreamedBlock>, at: number): ReadonlyArray<StreamedBlock> =>
	blocks.map((block, index) => (index === at ? {...block, claimed: true} : block));

/**
 * One `stream_event` frame — the deltas of the reply being written — as the growing row it changes.
 *
 * `SDKPartialAssistantMessage.event` is "one Anthropic Messages API streaming event" (`sdk.d.ts`,
 * `0.3.259`), so the six members this reads are the Messages API's own: `message_start` opens a
 * message and names its id, `content_block_start` opens a block, `content_block_delta` carries a
 * `text_delta`, and `content_block_stop` closes one. Thinking, tool-input and signature deltas are
 * not text and are held out on purpose — the port union is text-only, and a streamed thinking row
 * is the `thinking` item kind, never folded into the reply.
 *
 * Read structurally rather than through the SDK's own event types, for the reason every other
 * handler in this file is: this directory imports no runtime and must survive a delta kind the pin
 * has never seen.
 */
export const partialEvents = (
	message: unknown,
	mapping: Mapping,
	options: MappingOptions,
): MappingStep => {
	if (!isRecord(message) || !isRecord(message.event)) return skipMessage(mapping);
	const frame = message.event;
	const at = timestampOf(message, options.at);

	if (frame.type === "message_start") {
		const body = frame.message;
		const id = isRecord(body) && typeof body.id === "string" ? body.id : null;
		return {mapping: {...mapping, streamId: id}, events: []};
	}

	const streamId = mapping.streamId;
	if (streamId === null || typeof frame.index !== "number") return skipMessage(mapping);
	const index = frame.index;

	if (frame.type === "content_block_start") {
		if (!isRecord(frame.content_block) || frame.content_block.type !== "text") {
			return skipMessage(mapping);
		}
		const block: StreamedBlock = {
			messageId: streamId,
			index,
			id: streamedItemId(streamId, index),
			at,
			text: typeof frame.content_block.text === "string" ? frame.content_block.text : "",
			claimed: false,
		};
		return {mapping: {...mapping, blocks: [...mapping.blocks, block]}, events: []};
	}

	const open = mapping.blocks.findIndex(
		(block) => block.messageId === streamId && block.index === index && !block.claimed,
	);
	if (open < 0) return skipMessage(mapping);
	const block = mapping.blocks[open] as StreamedBlock;

	if (frame.type === "content_block_delta") {
		if (!isRecord(frame.delta) || frame.delta.type !== "text_delta") return skipMessage(mapping);
		const text = block.text + (typeof frame.delta.text === "string" ? frame.delta.text : "");
		const grown = {...block, text};
		const blocks = mapping.blocks.map((one, at) => (at === open ? grown : one));
		// Under the interval the row still grows, it just does not repaint: the next event that does
		// carries every delta accumulated since, so throttling costs latency and never text.
		return at - mapping.emittedAt < STREAM_EMIT_INTERVAL_MS
			? {mapping: {...mapping, blocks}, events: []}
			: {mapping: {...mapping, blocks, emittedAt: at}, events: [item(streamingItem(grown))]};
	}

	// A closed block repaints whatever the interval last withheld, so the whole block is on screen
	// before its complete frame arrives — and stays right even if that frame never does.
	if (frame.type === "content_block_stop") {
		return {mapping: {...mapping, emittedAt: at}, events: [item(streamingItem(block))]};
	}
	return skipMessage(mapping);
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
	const events: AgentEvent[] = [];
	let blocks = mapping.blocks;
	if (text.length > 0 || interrupted) {
		const messageId = isRecord(body) && typeof body.id === "string" ? body.id : null;
		const slot = claimable(blocks, messageId);
		const streamed = slot < 0 ? undefined : blocks[slot];
		if (slot >= 0) blocks = claim(blocks, slot);
		// The streamed row's id, so the whole reply *replaces* the growing one rather than landing
		// beside it. Absent a stream this is `message.uuid`, exactly as it was before partials.
		const id =
			streamed?.id ?? (typeof message.uuid === "string" ? message.uuid : `assistant-${at}`);
		events.push(
			item({
				kind: "assistant",
				id: itemId(id),
				timestamp: streamed?.at ?? at,
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
	return {mapping: {...mapping, toolCalls, blocks}, events};
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
	// The turn is over, so its stream is too. A block left unclaimed here streamed a reply whose
	// complete frame never came; the core settles that row when the phase leaves `prompting`
	// (`ai-agent/core/fold.ts`), and holding it any longer would let the next turn claim it.
	const settled: Mapping = {...mapping, streamId: null, blocks: [], emittedAt: 0};
	const failed = message.is_error === true || message.subtype !== "success";
	if (failed) {
		const id = typeof message.uuid === "string" ? message.uuid : `result-${at}`;
		const subtype = typeof message.subtype === "string" ? message.subtype : "error";
		return {
			mapping: settled,
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
		mapping: settled,
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
