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
import {
	boundToolResult,
	byteLength,
	type CommandRef,
	type ItemId,
	type JsonValue,
	type SubagentSlot,
	type TranscriptItem,
} from "../../ai-agent/ports/index.ts";
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
 * The reasoning row of a turn, keyed off the turn's own row and suffixed. One frame carrying both a
 * thinking block and text is two rows, and two rows sharing an id would fold into one — and the
 * deltas that grow this row take the same key, so growing and settled are one row.
 */
const thinkingId = (turnId: string): ItemId => itemId(`${turnId}:thinking`);

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
	/**
	 * The subagent-spawning call this reply is being written inside, held for the same reason `id`
	 * is: `message_start` is where the stream says it, and every later frame of the turn carries
	 * only its own per-delta envelope. Without it the upserts of a nested reply land untagged and
	 * the settled row that replaces them changes parent as it settles.
	 */
	readonly parentId: string | null;
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
	/**
	 * The reasoning block the deltas are growing, as they have written it so far; empty when none is
	 * open. It needs no id, clock or parent of its own: a reasoning block belongs to the turn the
	 * open reply already names, and its row is that reply's id suffixed `:thinking` — the same key
	 * `assistantEvents` settles on, so the growing row and the settled one are one row (#8288).
	 *
	 * Reset at each reasoning block rather than joined across them, because the frame that settles
	 * one carries that block alone: joining would grow a row the settle then shrinks.
	 */
	readonly thinking: string;
	/** Every subagent slot this stream has opened, by the spawning call's id. */
	readonly subagents: ReadonlyMap<string, SubagentSlot>;
	/** How many messages this mapping had nothing to say about. */
	readonly skipped: number;
}

export const emptyMapping: Mapping = {
	model: "",
	toolCalls: new Map(),
	partial: null,
	settled: null,
	thinking: "",
	subagents: new Map(),
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

/**
 * The label a spawning call's own input gives its worker — `Task`/`Agent`'s `subagent_type`, which
 * is the only field of the call that names what was spawned. A call whose input carries none is not
 * read as a spawn here: the slot's fallback label is the tool's name, and that path opens from the
 * nested frames instead (`slotFor`), never from a guess about which tools spawn workers.
 */
const spawnTypeOf = (input: JsonValue): string | null => {
	if (!isRecord(input)) return null;
	const type = input.subagent_type;
	return typeof type === "string" && type.length > 0 ? type : null;
};

const counted = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * What a worker has spent so far, read off one of its assistant frames.
 *
 * Every input field plus the output, because that is the running total the backend itself reports:
 * in `subagent-turn.json` the worker's first turn adds to 18,934 against the 18,981 the
 * `task_progress` frame beside it carries (`SDKTaskProgressMessage.usage.total_tokens`, `sdk.d.ts`
 * 0.3.259), and its second to 25,229 against 25,508. Counting `input_tokens` alone would report 2
 * for a turn that spent nineteen thousand.
 *
 * It is already cumulative — a turn's `cache_read_input_tokens` is the previous turn's cache — so
 * the slot takes the highest frame rather than a sum, which in that same capture would report
 * 88,326 for a worker that spent 25,508.
 */
const frameTokensOf = (body: unknown): number => {
	if (!isRecord(body)) return 0;
	const usage = body.usage;
	if (!isRecord(usage)) return 0;
	return (
		counted(usage.input_tokens) +
		counted(usage.cache_creation_input_tokens) +
		counted(usage.cache_read_input_tokens) +
		counted(usage.output_tokens)
	);
};

/** The one line a slot shows for an item: its first non-empty line, or a tool row's name. */
const lineOf = (one: TranscriptItem): string => {
	const text = one.kind === "tool" ? one.name : one.text;
	return (
		text
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim() ?? ""
	);
};

const openSlot = (id: string, type: string, at: number): SubagentSlot => ({
	id: itemId(id),
	type,
	lastLine: "",
	startedAt: at,
	tokens: 0,
	// A sidechain is one worker: the SDK drives each through its own spawning call.
	workers: 1,
	items: [],
	status: "running",
});

interface SlotStep {
	readonly subagents: ReadonlyMap<string, SubagentSlot>;
	readonly events: ReadonlyArray<AgentEvent>;
}

/**
 * The slot a nested item belongs to, opened from the spawning call when this is the first frame to
 * name it. A parent this mapping never saw the call for has no slot and never gets one: the type
 * and the start clock both live on that call, and inventing either would put a lie in the list.
 */
const slotFor = (mapping: Mapping, parentId: string): SubagentSlot | null => {
	const open = mapping.subagents.get(parentId);
	if (open !== undefined) return open;
	const call = mapping.toolCalls.get(parentId);
	return call === undefined ? null : openSlot(parentId, call.name, call.at);
};

/**
 * The worker's rows keyed the way the transcript keys them: a row re-sent under an id the slot
 * already holds replaces it in place, so a tool call that opens `running` and settles `ok` is one
 * entry rather than two. `core/fold.ts` replaces a slot whole and folds nothing inside it, so a
 * duplicate written here is a duplicate on state and in every view of the slot (#8403).
 */
const withItem = (
	items: ReadonlyArray<TranscriptItem>,
	one: TranscriptItem,
): ReadonlyArray<TranscriptItem> => {
	const at = items.findIndex((candidate) => candidate.id === one.id);
	return at < 0
		? [...items, one]
		: items.map((candidate, index) => (index === at ? one : candidate));
};

/**
 * Fold one frame's items, and what that frame spent, into the slots of the calls they ran inside.
 *
 * A finished slot is left exactly as it was (founder ruling Q2 on #8384: a finished subagent goes
 * back to today's plain tool row, so nothing live moves for it again). Every touched slot is
 * re-emitted whole, which is the contract `SubagentEvent` states: the fold replaces by id.
 */
const foldSlots = (
	mapping: Mapping,
	items: ReadonlyArray<TranscriptItem>,
	frameParentId: string | null,
	tokens: number,
): SlotStep => {
	const next = new Map(mapping.subagents);
	const touched: Array<string> = [];
	const touch = (parentId: string, grow: (slot: SubagentSlot) => SubagentSlot): void => {
		const slot = next.get(parentId) ?? slotFor(mapping, parentId);
		if (slot === null || slot.status === "finished") return;
		next.set(parentId, grow(slot));
		if (!touched.includes(parentId)) touched.push(parentId);
	};
	for (const one of items) {
		if (one.parentId === undefined) continue;
		const line = lineOf(one);
		touch(one.parentId, (slot) => ({
			...slot,
			items: withItem(slot.items, one),
			lastLine: line.length > 0 ? line : slot.lastLine,
		}));
	}
	if (frameParentId !== null && tokens > 0) {
		touch(frameParentId, (slot) => ({...slot, tokens: Math.max(slot.tokens, tokens)}));
	}
	const events = touched.flatMap((id): ReadonlyArray<AgentEvent> => {
		const slot = next.get(id);
		return slot === undefined ? [] : [{kind: "subagent", slot}];
	});
	return {subagents: next, events};
};

/**
 * A streamed upsert of a nested reply moves the slot's line and nothing else — the row itself joins
 * `slot.items` once, when the stream settles it. Appending each delta would put one copy of the
 * growing reply in the slot per word.
 */
const slotLine = (mapping: Mapping, parentId: string | null, line: string): SlotStep => {
	if (parentId === null || line.length === 0) return {subagents: mapping.subagents, events: []};
	const slot = mapping.subagents.get(parentId) ?? slotFor(mapping, parentId);
	if (slot === null || slot.status === "finished")
		return {subagents: mapping.subagents, events: []};
	const next = {...slot, lastLine: line};
	return {
		subagents: new Map(mapping.subagents).set(parentId, next),
		events: [{kind: "subagent", slot: next}],
	};
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
	// Read before anything is pushed: every item this frame emits carries the tag, not the tool rows
	// alone. Reading it after the pushes is what left a subagent's reasoning and prose rendering as
	// top-level rows of the agent's own turn (#8403).
	const parentId = parentToolUseIdOf(message) ?? row?.parentId ?? null;
	const tagged = parentId === null ? {} : {parentId: itemId(parentId)};
	const emitted: Array<TranscriptItem> = [];
	const thinking = thinkingOf(body);
	// Only a frame of the open reply's own turn ends it, for the same reason it alone closes the
	// reply below: a subagent's frame arrives mid-stream and carries a stop reason of its own.
	const endsOpen = open !== null && ends;
	// What the deltas of this turn's open reasoning block wrote, when the run streamed them. A frame
	// carrying the block settles the row they drew; an *ending* frame that carries no block settles
	// it at the text they wrote, because a cut turn must not leave that row partial forever (#8288).
	const reasoning =
		thinking.length > 0 ? thinkingTextOf(thinking) : endsOpen ? mapping.thinking : "";
	if (reasoning.length > 0) {
		emitted.push({
			kind: "thinking",
			id: thinkingId(id),
			timestamp: at,
			text: reasoning,
			...tagged,
		});
	}
	if (settles && (text.length > 0 || interrupted)) {
		emitted.push({
			kind: "assistant",
			id: itemId(id),
			timestamp: at,
			text,
			...(interrupted ? {interrupted: true} : {}),
			...tagged,
		});
	}
	const events: AgentEvent[] = emitted.map(item);
	let toolCalls = mapping.toolCalls;
	let subagents = mapping.subagents;
	for (const use of toolUsesOf(body)) {
		toolCalls = withCall(toolCalls, use.id, {name: use.name, input: use.input, at, parentId});
		const toolRow = boundToolOutput(
			{
				kind: "tool",
				id: itemId(use.id),
				timestamp: at,
				name: use.name,
				input: use.input,
				status: "running",
				output: "",
				...tagged,
			},
			options.toolResultLimit,
		);
		emitted.push(toolRow);
		events.push(item(toolRow));
		const spawnType = spawnTypeOf(use.input);
		if (spawnType !== null) {
			const slot = openSlot(use.id, spawnType, at);
			subagents = new Map(subagents).set(use.id, slot);
			events.push({kind: "subagent", slot});
		}
	}
	const folded = foldSlots(
		{...mapping, toolCalls, subagents},
		emitted,
		parentId,
		frameTokensOf(body),
	);
	events.push(...folded.events);
	// Only a frame of the open reply's own turn touches it. Any other assistant frame can arrive
	// mid-stream — a subagent's does — and closing on that one would freeze the reply mid-word.
	return {
		mapping: {
			...mapping,
			toolCalls,
			subagents: folded.subagents,
			partial: open === null ? mapping.partial : ends ? null : reply,
			// A row this frame leaves settled stays reachable, so a further frame of the same turn —
			// a trailing content block — still lands on it rather than beside it.
			settled: reply === null || (open !== null && !ends) ? mapping.settled : reply,
			thinking: thinking.length > 0 || endsOpen ? "" : mapping.thinking,
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

/**
 * The reasoning one frame adds: "concatenate the `thinking` values of successive `thinking_delta`
 * events to assemble the block's full `thinking` value" (`@anthropic-ai/sdk`, `BetaThinkingDelta`).
 *
 * A `signature_delta` carries a `signature` and no reasoning at all — an opaque value the API reads
 * back, not text (`BetaSignatureDelta`) — so it adds nothing here and reaches no row. The captured
 * `thinking_delta` frames add nothing either: the provider ships this pin's reasoning encrypted, so
 * their `thinking` is empty and the settled block is what says a block was there.
 */
const thinkingDeltaOf = (event: Record<string, unknown>): string => {
	const delta = event.delta;
	if (!isRecord(delta) || delta.type !== "thinking_delta") return "";
	return typeof delta.thinking === "string" ? delta.thinking : "";
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
 * A `thinking_delta` is not assistant text. The reasoning a turn streams grows a `thinking` row of
 * its own, keyed off this reply's id and settled by the same frame that settles the block — so the
 * row the operator watches open is the row that stays (#8288). It never touches the reply.
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
		const parentId = parentToolUseIdOf(message);
		return {mapping: {...mapping, partial: {id, text: "", at, parentId}, thinking: ""}, events: []};
	}
	const open = mapping.partial;
	if (open === null) return skipMessage(mapping);
	const tagged = open.parentId === null ? {} : {parentId: itemId(open.parentId)};
	if (event.type === "message_stop" || stopsStream(event)) {
		const settledRows: Array<TranscriptItem> = [];
		// Reasoning the deltas drew that no `assistant` frame ever carried — a turn cut mid-block is
		// the case. The end of the stream is the last moment it can settle, and a row left marked
		// partial is a row nothing checkpoints past for the rest of the session (#8170).
		if (mapping.thinking.length > 0) {
			settledRows.push({
				kind: "thinking",
				id: thinkingId(open.id),
				timestamp: open.at,
				text: mapping.thinking,
				...tagged,
			});
		}
		if (open.text.length > 0) {
			settledRows.push({
				kind: "assistant",
				id: itemId(open.id),
				timestamp: open.at,
				text: open.text,
				...tagged,
			});
		}
		const folded = foldSlots(mapping, settledRows, open.parentId, 0);
		return {
			mapping: {
				...mapping,
				partial: null,
				settled: open,
				thinking: "",
				subagents: folded.subagents,
			},
			events: [...settledRows.map(item), ...folded.events],
		};
	}
	if (event.type === "content_block_start") {
		const block = event.content_block;
		if (!isRecord(block)) return skipMessage(mapping);
		if (block.type === "thinking") {
			// The block's own opening text, replacing whatever the last reasoning block wrote: the
			// `assistant` frame that settles a block carries that block alone. A block opens empty and
			// its `signature` is not reasoning, so nothing is drawn until a delta arrives.
			return {
				mapping: {...mapping, thinking: typeof block.thinking === "string" ? block.thinking : ""},
				events: [],
			};
		}
		if (block.type !== "text") return skipMessage(mapping);
		// `textOf` joins a body's text blocks on a newline, so the growing row joins them the same
		// way: without this the last upsert would reflow text the operator was already reading.
		const lead = open.text.length === 0 ? "" : "\n";
		const opening = typeof block.text === "string" ? block.text : "";
		return {mapping: {...mapping, partial: grown(open, lead + opening)}, events: []};
	}
	if (event.type !== "content_block_delta") return skipMessage(mapping);
	const reasoning = thinkingDeltaOf(event);
	if (reasoning.length > 0) {
		const thinking = mapping.thinking + reasoning;
		const upsert: TranscriptItem = {
			kind: "thinking",
			id: thinkingId(open.id),
			timestamp: open.at,
			text: thinking,
			partial: true,
			...tagged,
		};
		const line = slotLine(mapping, open.parentId, lineOf(upsert));
		return {
			mapping: {...mapping, thinking, subagents: line.subagents},
			events: [item(upsert), ...line.events],
		};
	}
	const text = textDeltaOf(event);
	if (text.length === 0) return skipMessage(mapping);
	const partial = grown(open, text);
	const upsert: TranscriptItem = {
		kind: "assistant",
		id: itemId(partial.id),
		timestamp: partial.at,
		text: partial.text,
		partial: true,
		...tagged,
	};
	const line = slotLine(mapping, partial.parentId, lineOf(upsert));
	return {
		mapping: {...mapping, partial, subagents: line.subagents},
		events: [item(upsert), ...line.events],
	};
};

/** How much of a notice's own prose rides the summary line before the rest folds into `detail`. */
const NOTICE_SUMMARY_LIMIT = 200;

/**
 * How many bytes of a notice's body ride `detail`, marker included.
 *
 * A different budget from `NOTICE_SUMMARY_LIMIT`'s, which guards the always-visible line: this one
 * guards `TRANSCRIPT_WINDOW_BYTE_LIMIT`, the live tail's. `itemBytes` counts the whole item with
 * `detail` in it, so an unbounded body — a skill frame's is some ten kilobytes — spends the tail's
 * budget and pushes older groups out of the operator's history (#8765). Sized like a tool result's
 * own allowance, because a notice's body spends that budget the same way; its own constant rather
 * than that one, so a change to what a tool result may spend does not silently move this ceiling.
 */
const NOTICE_DETAIL_BYTE_LIMIT = 8_000;

/** What an opened disclosure reads at the cut, so the panel never passes a part off as the whole. */
const NOTICE_DETAIL_CUT = "\n\n… cut to fit the transcript window; the rest is not here.";

/**
 * A notice's body bounded before the item is minted, cut on a code-point boundary by the same
 * `boundToolResult` a tool row's output goes through. `SystemItem.detail` has no field to carry an
 * omission count, so the cut says so inside the string it returns.
 */
const boundNoticeDetail = (detail: string): string => {
	const bound = boundToolResult(detail, NOTICE_DETAIL_BYTE_LIMIT - byteLength(NOTICE_DETAIL_CUT));
	return bound.omitted.bytes === 0 ? bound.text : `${bound.text}${NOTICE_DETAIL_CUT}`;
};

const LOCAL_COMMAND_OPEN = "<local-command-stdout>";
const LOCAL_COMMAND_CLOSE = "</local-command-stdout>";

const CAVEAT_OPEN = "<local-command-caveat>";
const CAVEAT_CLOSE = "</local-command-caveat>";

/**
 * The escape a command writes to colour its own output for a terminal. The captured `/model`
 * result carries two, and left in they reach a transcript as unprintable bytes inside the line.
 */
const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * What a local command printed, when this user frame is a command's output rather than a turn.
 *
 * The CLI records a slash command's result as a user-role message whose whole text is that one
 * wrapper (`fixtures/local-command-turn.json`), so the frame is the operator's only in role — read
 * as a turn it puts a system echo and its markup under YOU (#8211).
 *
 * The match is the captured shape and nothing looser: the text must *be* the wrapper, so a prompt
 * quoting or explaining these tags is still the operator's own and stays one. The sibling
 * `<local-command-caveat>` frame is `isLocalCommandCaveat`'s, and the `<command-name>` frame
 * between them is `localCommandInvocationOf`'s.
 */
const localCommandOutputOf = (text: string): string | null => {
	const trimmed = text.trim();
	if (!trimmed.startsWith(LOCAL_COMMAND_OPEN) || !trimmed.endsWith(LOCAL_COMMAND_CLOSE)) {
		return null;
	}
	const inner = trimmed.slice(LOCAL_COMMAND_OPEN.length, -LOCAL_COMMAND_CLOSE.length);
	return inner.replaceAll(sgr, "").trim();
};

/**
 * Whether this user frame is the caveat the CLI writes ahead of a slash command's output.
 *
 * Fixed boilerplate addressed to the model — "DO NOT respond to these messages" — identical on
 * every occurrence and carrying nothing a transcript reader can use, so unlike the command's own
 * output it becomes no row at all (#8641). Matched the same way as that output: the trimmed text
 * must *be* the wrapper, so an operator prompt quoting the tag stays the operator's own turn.
 */
const isLocalCommandCaveat = (text: string): boolean => {
	const trimmed = text.trim();
	return trimmed.startsWith(CAVEAT_OPEN) && trimmed.endsWith(CAVEAT_CLOSE);
};

/**
 * One tag of the invocation record, matched at the head of what is left. The set is open rather
 * than the three the plain slash command writes, because a plugin or skill invocation carries
 * siblings of its own — `<skill-format>` on every one (`fixtures/local-command-skill-turn.json`).
 */
const COMMAND_TAG = /^<([a-z][a-z-]*)>([\s\S]*?)<\/\1>/;

/** The CLI's marker that this frame is a skill's, and that the skill's own body follows its tags. */
const SKILL_FORMAT = "skill-format";

/**
 * The command a slash-command invocation names, with its arguments, when this user frame is the
 * CLI's record of that invocation rather than a turn.
 *
 * The middle of the three frames one slash command writes: the caveat, this record, then the
 * output. Unlike the caveat it carries something a reader wants — which command ran — so it becomes
 * its own notice rather than nothing (#8665). `<command-message>` restates the name and is dropped.
 *
 * Order is not fixed and the tag set is not closed: a plain command writes `<command-name>` first,
 * a plugin command writes `<command-message>` first, and a skill's frame adds `<skill-format>` and
 * then the whole skill body. So the read is the tags themselves — every one consumed in turn, each
 * at most once, and `<command-name>` required. What is left over decides the rest: on a skill frame
 * it is the body and rides the notice's `detail`, and anywhere else it means an operator wrote
 * about the markup, which stays their own turn.
 */
const localCommandInvocationOf = (
	text: string,
): {readonly text: string; readonly detail?: string} | null => {
	let rest = text.trim();
	const parts = new Map<string, string>();
	while (rest.length > 0) {
		const match = COMMAND_TAG.exec(rest);
		if (match === null) break;
		const [whole, tag, inner] = match;
		if (tag === undefined || inner === undefined || parts.has(tag)) return null;
		parts.set(tag, inner.replaceAll(sgr, "").trim());
		rest = rest.slice(whole.length).trimStart();
	}
	const name = parts.get("command-name") ?? "";
	if (name.length === 0) return null;
	// A skill's own body follows its tags in the same frame, and only there: without the CLI's
	// `<skill-format>` marker, text past the tags is an operator writing about the markup.
	if (rest.length > 0 && !parts.has(SKILL_FORMAT)) return null;
	const args = parts.get("command-args") ?? "";
	const line = args.length === 0 ? name : `${name} ${args}`;
	return rest.length === 0
		? {text: line}
		: {text: line, detail: boundNoticeDetail(rest.replaceAll(sgr, ""))};
};

/**
 * One command's output as the collapsed notice's two fields: the line always shown, and the output
 * behind the disclosure whenever that line is not all of it (`shell/chat/SessionRow.tsx`), bounded
 * at `NOTICE_DETAIL_BYTE_LIMIT`.
 */
const noticeOf = (output: string): {readonly text: string; readonly detail?: string} => {
	const first =
		output
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim() ?? "";
	const line =
		first.length > NOTICE_SUMMARY_LIMIT ? `${first.slice(0, NOTICE_SUMMARY_LIMIT)}…` : first;
	return line === output ? {text: line} : {text: line, detail: boundNoticeDetail(output)};
};

/**
 * What one user frame stands for: the operator's own turn, or one of the two slash-command frames
 * the CLI writes under the operator's role — the invocation record and the command's output. Each
 * is read off its own text alone, so nothing has to survive between the frames of one command.
 */
const promptItemOf = (
	text: string,
	base: {readonly id: ItemId; readonly timestamp: number; readonly parentId?: ItemId},
): TranscriptItem => {
	const output = localCommandOutputOf(text);
	if (output !== null) return {kind: "system", ...base, ...noticeOf(output)};
	const invocation = localCommandInvocationOf(text);
	if (invocation !== null) return {kind: "system", ...base, ...invocation};
	return {kind: "user", ...base, text};
};

/**
 * A user frame is either the operator's prompt, a local command's caveat, invocation record or
 * output, or the results of the calls the last turn opened.
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
	const framedParentId = parentToolUseIdOf(message);
	if (results.length === 0) {
		const text = textOf(body);
		if (text.length === 0) return skipMessage(mapping);
		if (isLocalCommandCaveat(text)) return skipMessage(mapping);
		const id = typeof message.uuid === "string" ? message.uuid : `user-${at}`;
		// A worker's inbound turn is parent-tagged too, and untagged it landed top-level beside the
		// agent's own prose — seen live on #8400's desk run.
		const tag = framedParentId === null ? {} : {parentId: itemId(framedParentId)};
		const prompt = promptItemOf(text, {id: itemId(id), timestamp: at, ...tag});
		const folded = foldSlots(mapping, [prompt], framedParentId, 0);
		return {
			mapping: {...mapping, subagents: folded.subagents},
			events: [item(prompt), ...folded.events],
		};
	}
	let toolCalls = mapping.toolCalls;
	let skipped = mapping.skipped;
	const settled: Array<TranscriptItem> = [];
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
		const row = boundToolOutput(
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
		);
		settled.push(row);
		events.push(item(row));
	}
	const folded = foldSlots({...mapping, toolCalls}, settled, framedParentId, 0);
	// A settling call is the one thing that ends its worker's slot, and it must be reported: the core
	// settles a running slot at the turn's end as a backstop only, so a slot left running here is a
	// state no checkpoint can be taken on (#8401).
	let subagents = folded.subagents;
	const ended: Array<AgentEvent> = [];
	for (const one of settled) {
		const slot = subagents.get(one.id);
		if (slot === undefined || slot.status === "finished") continue;
		const finished: SubagentSlot = {...slot, status: "finished"};
		subagents = new Map(subagents).set(one.id, finished);
		ended.push({kind: "subagent", slot: finished});
	}
	return {
		mapping: {...mapping, toolCalls, subagents, skipped},
		events: [...events, ...folded.events, ...ended],
	};
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
	// The CLI is not the SDK we pin, and the drift between them is the whole point of carrying it
	// (#7580). A frame without the field emits nothing rather than a placeholder: the core's slot
	// stays `null`, which is what says nobody has reported one (#7955).
	const version = message.claude_code_version;
	return {
		mapping: {...mapping, model},
		events: [
			{kind: "usage", turn: MODEL_ANNOUNCEMENT, model, inputTokens: 0, outputTokens: 0, cost: 0},
			...(typeof version === "string" && version.length > 0
				? [{kind: "version", version} as const]
				: []),
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

/**
 * `/clear`, plan-mode exit and the fresh-session flows: the CLI ended this conversation and opened
 * another under `new_conversation_id` (`sdk.d.ts` at the `0.3.259` pin, `SDKConversationResetMessage`,
 * whose own note tells a surface to "mount a fresh transcript under new_conversation_id").
 *
 * The mapping goes back to empty with it. Its memory is the ended conversation's — the open tool
 * calls it is holding names, the reply its deltas were growing, the subagent slots underneath — and
 * carrying any of that into the next conversation would join a new frame to a row that no longer
 * exists. `model` and `skipped` survive: the model is the session's, and the skip count is this
 * stream's running total rather than a conversation's.
 *
 * A frame with no usable id is skipped rather than reset on, because the whole event *is* the id: a
 * reset the core cannot key would swap the session onto nothing and strand the next prompt.
 */
export const conversationResetEvents = (message: unknown, mapping: Mapping): MappingStep => {
	if (!isRecord(message)) return skipMessage(mapping);
	const sessionId = message.new_conversation_id;
	if (typeof sessionId !== "string" || sessionId.length === 0) return skipMessage(mapping);
	return {
		mapping: {...emptyMapping, model: mapping.model, skipped: mapping.skipped},
		events: [{kind: "session-reset", sessionId}],
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
 * fifteen arms none of which a golden capture backs — `taskNoticeEvents` below is the one that a
 * capture and a founder ruling do back, and it is the only one.
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

/**
 * What a settled task reads as. `SDKTaskNotificationMessage.status` is
 * `'completed' | 'failed' | 'stopped'` (`sdk.d.ts`, 0.3.259); only the first wants a different
 * word, and a value the union grows later is shown verbatim rather than forced into one of these.
 * The frame is raised when a task settles, so one carrying no status at all still settled.
 */
const taskOutcomeOf = (status: unknown): string => {
	if (typeof status !== "string" || status.length === 0) return "finished";
	return status === "completed" ? "finished" : status;
};

/**
 * A settled task's notice, as one line naming the worker and how it ended.
 *
 * The frame carries the worker's entire final report in `summary`, and the collapsed-notice arm
 * above would fold that whole payload into `detail` — a second copy of a report the spawning call's
 * own tool result already carries, in the one transcript the running list exists to keep a worker's
 * output out of. The founder ruled "shrink it"
 * (https://github.com/kamp-us/phoenix/issues/8475#issuecomment-5589392284): one line, the worker's
 * name and its outcome, linking to that worker's row in the subagent list where the full report
 * already lives. The spawning `Agent` tool result is untouched — it is not this frame.
 *
 * The name is the slot's, so the notice and the list row a reader jumps to say the same word about
 * the same worker. A task holding no slot — a backgrounded `Bash` raises this frame too — falls
 * back to the spawning call's name and carries no link, because there is no row to link to.
 */
export const taskNoticeEvents = (
	message: unknown,
	mapping: Mapping,
	options: MappingOptions,
): MappingStep => {
	if (!isRecord(message)) return skipMessage(mapping);
	const at = timestampOf(message, options.at);
	const id = typeof message.uuid === "string" ? message.uuid : `notice-${at}`;
	const callId = typeof message.tool_use_id === "string" ? message.tool_use_id : "";
	const slot = callId.length === 0 ? undefined : mapping.subagents.get(callId);
	const name = slot?.type ?? mapping.toolCalls.get(callId)?.name ?? "task";
	return {
		mapping,
		events: [
			item({
				kind: "system",
				id: itemId(id),
				timestamp: at,
				text: `${name} ${taskOutcomeOf(message.status)}`,
				...(slot === undefined ? {} : {subagent: itemId(callId)}),
			}),
		],
	};
};
