/**
 * The reply as it is written (#8160), driven by the golden `partial-assistant-turn` capture — a run
 * of `query()` with `includePartialMessages: true`, kept whole and in the order the CLI emitted it
 * (`fixtures/PROVENANCE.md`).
 *
 * The capture is what makes these cases worth anything. Two facts it settles are not readable off
 * `sdk.d.ts` at all: the complete `assistant` frame lands **before** its block's
 * `content_block_stop`, and the whole reply arrives over two `text_delta`s rather than one per
 * token — so a mapping proved against a hand-written envelope would be proved against the wrong
 * stream.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {describe, expect, it} from "vitest";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {type AssistantItem, isTranscriptItem} from "../../ai-agent/ports/index.ts";
import {toAgentEvents} from "./events.ts";
import {loadFixture} from "./fixtures/load.ts";
import {emptyMapping, type Mapping, STREAM_EMIT_INTERVAL_MS} from "./map.ts";

const AT = 1_700_000_000_000;

const turn = (): ReadonlyArray<SDKMessage> =>
	loadFixture("partial-assistant-turn") as ReadonlyArray<SDKMessage>;

/**
 * Fold the capture with a clock that advances `step` per frame, which is the axis the emit interval
 * is read on. `step` of zero is one instant: every delta lands inside the interval.
 */
const run = (
	stream: ReadonlyArray<SDKMessage>,
	step: number,
): {readonly events: ReadonlyArray<AgentEvent>; readonly mapping: Mapping} => {
	const events: Array<AgentEvent> = [];
	let mapping = emptyMapping;
	stream.forEach((message, index) => {
		const folded = toAgentEvents(message, mapping, {at: AT + index * step});
		mapping = folded.mapping;
		events.push(...folded.events);
	});
	return {events, mapping};
};

const assistants = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<AssistantItem> =>
	events.flatMap((event) =>
		event.kind === "item" && event.item.kind === "assistant" ? [event.item] : [],
	);

const SENTENCE = "The quick brown fox jumps over the lazy dog.";

describe("a streamed reply", () => {
	it("grows one row rather than appending one per delta", () => {
		const rows = assistants(run(turn(), STREAM_EMIT_INTERVAL_MS).events);
		expect(rows.length).toBeGreaterThan(1);
		expect(new Set(rows.map((row) => row.id)).size).toBe(1);
		expect(rows.map((row) => row.text)).toEqual(["The", SENTENCE, SENTENCE]);
	});

	it("marks every row but the last as still arriving, and the last as the whole reply", () => {
		const rows = assistants(run(turn(), STREAM_EMIT_INTERVAL_MS).events);
		const marks = rows.map((row) => row.streaming);
		expect(marks).toEqual([true, true, undefined]);
		expect(rows.at(-1)).toEqual({
			kind: "assistant",
			id: rows[0]?.id,
			timestamp: rows[0]?.timestamp,
			text: SENTENCE,
		});
	});

	it("emits every row through the port's own admission test", () => {
		const rows = assistants(run(turn(), STREAM_EMIT_INTERVAL_MS).events);
		expect(rows.every(isTranscriptItem)).toBe(true);
	});

	// The reason the last delta before the complete frame is not lost when the interval swallows it:
	// each emission carries the whole accumulated block, so a throttle costs latency and never text.
	it("still lands the whole reply when every delta falls inside one interval", () => {
		const rows = assistants(run(turn(), 0).events);
		expect(rows.at(-1)?.text).toBe(SENTENCE);
		expect(rows.length).toBeLessThan(3);
	});

	it("holds nothing of the stream once the turn's result lands", () => {
		const {mapping} = run(turn(), STREAM_EMIT_INTERVAL_MS);
		expect(mapping.streamId).toBeNull();
		expect(mapping.blocks).toEqual([]);
	});

	// A run without `includePartialMessages` is every frame of this capture minus the six
	// `stream_event`s, and it must still produce exactly the reply it always did (#8160 no-go).
	it("produces the same reply as the same run with the partial frames dropped", () => {
		const whole = assistants(run(turn(), STREAM_EMIT_INTERVAL_MS).events).at(-1);
		const without = assistants(
			run(
				turn().filter((message) => message.type !== "stream_event"),
				STREAM_EMIT_INTERVAL_MS,
			).events,
		);
		expect(without.length).toBe(1);
		expect(without[0]?.text).toBe(whole?.text);
		expect(without[0]?.streaming).toBeUndefined();
	});
});

describe("the join between a streamed row and the reply that finishes it", () => {
	// The frame's own uuid is fresh per delta (`sdk.d.ts`, `SDKPartialAssistantMessage`), so this is
	// the case that reds if the row is ever keyed on it.
	it("keys the row on the API message id, not on the partial frame's uuid", () => {
		const stream = turn();
		const start = stream.find(
			(message) => message.type === "stream_event" && message.event.type === "message_start",
		);
		const messageId =
			start !== undefined && start.type === "stream_event" && start.event.type === "message_start"
				? start.event.message.id
				: "";
		expect(messageId.length).toBeGreaterThan(0);
		const rows = assistants(run(stream, STREAM_EMIT_INTERVAL_MS).events);
		expect(rows[0]?.id).toBe(`stream:${messageId}:0`);
	});

	// The capture's own ordering: the complete frame lands before `content_block_stop`, so the stop
	// finds a claimed block and says nothing. A mapping that emitted there would re-open the reply.
	it("says nothing on the block's stop, because the complete reply already claimed the row", () => {
		const stream = turn();
		const stopAt = stream.findIndex(
			(message) => message.type === "stream_event" && message.event.type === "content_block_stop",
		);
		const completeAt = stream.findIndex((message) => message.type === "assistant");
		expect(completeAt).toBeGreaterThan(-1);
		expect(stopAt).toBeGreaterThan(completeAt);

		let mapping = emptyMapping;
		const events: Array<AgentEvent> = [];
		stream.slice(0, stopAt).forEach((message, index) => {
			const folded = toAgentEvents(message, mapping, {at: AT + index * STREAM_EMIT_INTERVAL_MS});
			mapping = folded.mapping;
			events.push(...folded.events);
		});
		const stop = toAgentEvents(stream[stopAt] as SDKMessage, mapping, {at: AT + 10_000});
		expect(stop.events).toEqual([]);
		expect(assistants(events).at(-1)?.streaming).toBeUndefined();
	});
});
