/**
 * Every case here is driven by a fixture captured from a real run (`fixtures/PROVENANCE.md`), never
 * a hand-written envelope: the SDK's message shapes are only observable at execution, so an invented
 * one would prove the mapping against a contract nobody emits
 * (`.patterns/golden-real-payload-fixtures.md`).
 *
 * The two cases that stamp a field over a captured stream — a subagent's `parent_tool_use_id`, a
 * withheld reasoning block — say so at the case and name what could not be forced.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {describe, expect, it} from "vitest";
import {upsertItem} from "../../ai-agent/core/fold.ts";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {
	byteLength,
	type ItemId,
	isSubagentSlot,
	TOOL_RESULT_BYTE_LIMIT,
	type TranscriptItem,
} from "../../ai-agent/ports/index.ts";
import {toAgentEvents} from "./events.ts";
import {loadFixture} from "./fixtures/load.ts";
import {emptyMapping, type Mapping, type MappingStep} from "./map.ts";

const AT = 1_700_000_000_000;

const messages = (name: Parameters<typeof loadFixture>[0]): ReadonlyArray<SDKMessage> =>
	loadFixture(name) as ReadonlyArray<SDKMessage>;

const message = (name: Parameters<typeof loadFixture>[0]): SDKMessage =>
	loadFixture(name) as SDKMessage;

/** Fold a whole captured turn, which is how the layer consumes it. */
const run = (stream: ReadonlyArray<SDKMessage>, mapping: Mapping = emptyMapping) => {
	const events: AgentEvent[] = [];
	let current = mapping;
	for (const one of stream) {
		const step: MappingStep = toAgentEvents(one, current, {at: AT});
		current = step.mapping;
		events.push(...step.events);
	}
	return {events, mapping: current};
};

const items = (events: ReadonlyArray<AgentEvent>) =>
	events.flatMap((event) => (event.kind === "item" ? [event.item] : []));

/** The transcript these events fold to, in the arrival order `upsertItem` gives it. */
const tail = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<TranscriptItem> =>
	items(events).reduce<ReadonlyArray<TranscriptItem>>(
		(carried, one) => upsertItem(carried, one),
		[],
	);

describe("toAgentEvents over a captured init", () => {
	it("reports the model the session named, and no phase", () => {
		const {events, mapping} = run([message("init")]);
		expect(events).toEqual([
			{
				kind: "usage",
				turn: "claude:model-announcement",
				model: "claude-fable-5-1",
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
			},
		]);
		expect(mapping.model).toBe("claude-fable-5-1");
	});

	it("reads a resumed session's init the same way", () => {
		const {events} = run([message("resumed-init")]);
		expect(events).toEqual([
			{
				kind: "usage",
				turn: "claude:model-announcement",
				model: "claude-fable-5-1",
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
			},
		]);
	});
});

describe("the mapping narrates no phase at all", () => {
	// A phase is a session's, and this file reads one message at a time: `init` leads a turn and
	// `result` ends one, so a phase read out of either here would fire on a history replay too
	// (#7963). The layer says where a turn ends; `phases.unit.test.ts` is where that is proven.
	it("emits no phase event over any captured stream", () => {
		const streams = [
			run([message("init")]),
			run(messages("assistant-turn")),
			run(messages("tool-turn")),
			run([message("error-result")]),
			run([message("permission-denied")]),
		];
		expect(streams.flatMap(({events}) => events.filter((one) => one.kind === "phase"))).toEqual([]);
	});
});

describe("toAgentEvents over a captured plain turn", () => {
	const {events} = run(messages("assistant-turn"));

	it("maps the assistant text to one item carrying the message uuid", () => {
		const assistants = items(events).filter((one) => one.kind === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.id).toBe("00000000-0000-4000-8000-000000000004");
		expect(assistants[0]).toMatchObject({kind: "assistant", text: "hello"});
		expect(assistants[0]?.interrupted).toBeUndefined();
	});

	it("maps the success result to a usage event and to no item", () => {
		const usage = events.filter((event) => event.kind === "usage");
		expect(usage).toHaveLength(2);
		expect(usage[1]).toEqual({
			kind: "usage",
			turn: "00000000-0000-4000-8000-000000000006",
			model: "claude-fable-5-1",
			inputTokens: 2,
			outputTokens: 4,
			cost: 0.37140550000000006,
		});
		expect(items(events).filter((one) => one.kind === "system")).toEqual([]);
	});

	it("timestamps the item off the message's own clock, not the fallback", () => {
		const assistant = items(events).find((one) => one.kind === "assistant");
		expect(assistant?.timestamp).toBe(Date.parse("2026-09-04T18:24:07.534Z"));
	});
});

describe("toAgentEvents over a captured tool turn", () => {
	const {events} = run(messages("tool-turn"));
	const tools = items(events).filter((one) => one.kind === "tool");

	it("opens the call as a running row with the tool's name and input", () => {
		expect(tools).toHaveLength(2);
		expect(tools[0]).toEqual({
			kind: "tool",
			id: "toolu_00000000000000000010",
			timestamp: Date.parse("2026-09-04T18:23:24.205Z"),
			name: "Bash",
			input: {command: "echo hello-tuval", description: "Echo hello-tuval"},
			status: "running",
			result: {text: "", omitted: {bytes: 0}},
		});
	});

	it("settles the call by re-sending the same id with its result", () => {
		expect(tools[1]?.id).toBe(tools[0]?.id);
		expect(tools[1]).toMatchObject({
			kind: "tool",
			name: "Bash",
			input: {command: "echo hello-tuval", description: "Echo hello-tuval"},
			status: "ok",
			result: {text: "hello-tuval", omitted: {bytes: 0}},
		});
	});

	it("keeps the settled row at the call's clock, not at its answer's", () => {
		expect(tools[1]?.timestamp).toBe(Date.parse("2026-09-04T18:23:24.205Z"));
		expect(tools[1]?.timestamp).toBe(tools[0]?.timestamp);
	});

	it("closes the call, so a second result for it would be counted rather than shown", () => {
		const {mapping} = run(messages("tool-turn"));
		expect(mapping.toolCalls.size).toBe(0);
	});
});

describe("toAgentEvents bounds one tool result", () => {
	const stream = messages("oversized-tool-turn");

	it("cuts an oversized result to the per-item bound and says what it dropped", () => {
		const {events} = run(stream);
		const settled = items(events).filter((one) => one.kind === "tool" && one.status === "ok");
		expect(settled).toHaveLength(1);
		const result = settled[0]?.kind === "tool" ? settled[0].result : undefined;
		expect(result).toBeDefined();
		expect(byteLength(result?.text ?? "")).toBeLessThanOrEqual(TOOL_RESULT_BYTE_LIMIT);
		expect(result?.omitted.bytes).toBe(8892 - TOOL_RESULT_BYTE_LIMIT);
	});

	it("takes the caller's own bound when it is given one", () => {
		const events: AgentEvent[] = [];
		let mapping = emptyMapping;
		for (const one of stream) {
			const step = toAgentEvents(one, mapping, {at: AT, toolResultLimit: 64});
			mapping = step.mapping;
			events.push(...step.events);
		}
		const settled = items(events).filter((one) => one.kind === "tool" && one.status === "ok");
		const result = settled[0]?.kind === "tool" ? settled[0].result : undefined;
		expect(byteLength(result?.text ?? "")).toBeLessThanOrEqual(64);
		expect(result?.omitted.bytes).toBe(8892 - 64);
	});
});

describe("toAgentEvents over a captured user prompt", () => {
	it("maps the operator's text to one user item carrying the frame's uuid", () => {
		const prompt = messages("session-messages")[0];
		expect(prompt).toBeDefined();
		const step = toAgentEvents(prompt as SDKMessage, emptyMapping, {at: AT});
		expect(step.events).toEqual([
			{
				kind: "item",
				item: {
					kind: "user",
					id: "00000000-0000-4000-8000-000000000028",
					timestamp: Date.parse("2026-09-04T18:23:21.494Z"),
					text: "Run the bash command: echo hello-tuval",
				},
			},
		]);
	});
});

describe("toAgentEvents over the captured failure frames", () => {
	it("turns an error result into one system line naming the subtype and the reason", () => {
		const {events} = run([message("error-result")]);
		expect(events).toEqual([
			{
				kind: "item",
				item: {
					kind: "system",
					id: "00000000-0000-4000-8000-000000000019",
					timestamp: AT,
					text: "error_max_turns: Reached maximum number of turns (1)",
				},
			},
		]);
	});

	it("turns a permission denial into one system line naming the denied tool", () => {
		const {events} = run([message("permission-denied")]);
		expect(items(events)).toEqual([
			{
				kind: "system",
				id: "00000000-0000-4000-8000-000000000021",
				timestamp: AT,
				text: "Bash denied: Permission to use Bash with command echo denied-please has been denied.",
			},
		]);
	});

	it("marks an aborted assistant message interrupted and keeps the text it got out", () => {
		const {events} = run([message("interrupted-assistant")]);
		const assistant = items(events)[0];
		expect(assistant?.kind).toBe("assistant");
		expect(assistant).toMatchObject({interrupted: true});
		expect(assistant?.kind === "assistant" && assistant.text.startsWith("# The Sea")).toBe(true);
	});
});

describe("toAgentEvents over a subagent's frames", () => {
	/**
	 * No committed capture holds a non-null `parent_tool_use_id`, because forcing one needs a live
	 * subagent run — an operator act with real spend (`fixtures/PROVENANCE.md`). So this case is the
	 * golden `tool-turn` stream with exactly that one field stamped over its assistant and user
	 * frames. The SDK types it `string | null` on both `SDKAssistantMessage` and `SDKUserMessage`,
	 * "non-null when the message was produced inside a subagent started by that tool_use"
	 * (`sdk.d.ts`, 0.3.259), and the capture already carries it as `null` — so the value is the whole
	 * difference and every other key stays the captured shape.
	 */
	const PARENT = "toolu_01SubagentParent";

	const insideSubagent = (stream: ReadonlyArray<SDKMessage>): ReadonlyArray<SDKMessage> =>
		stream.map((one) =>
			one.type === "assistant" || one.type === "user"
				? ({...one, parent_tool_use_id: PARENT} as SDKMessage)
				: one,
		);

	const toolItems = (stream: ReadonlyArray<SDKMessage>) =>
		items(run(stream).events).filter((one) => one.kind === "tool");

	it("marks every tool row a subagent opened with the call that spawned it", () => {
		const tools = toolItems(insideSubagent(messages("tool-turn")));
		expect(tools.length).toBeGreaterThan(0);
		expect(tools.map((one) => one.kind === "tool" && one.parentId)).toEqual(
			tools.map(() => PARENT),
		);
		expect(tools.map((one) => one.kind === "tool" && one.status)).toContain("ok");
	});

	it("leaves the captured top-level stream carrying no parent at all", () => {
		const tools = toolItems(messages("tool-turn"));
		expect(tools.length).toBeGreaterThan(0);
		expect(tools.map((one) => "parentId" in one)).toEqual(tools.map(() => false));
	});
});

describe("toAgentEvents over a captured thinking turn", () => {
	const {events} = run(messages("thinking-turn"));

	it("maps the reasoning block to a thinking item instead of losing the frame", () => {
		const thinking = items(events).filter((one) => one.kind === "thinking");
		expect(thinking).toHaveLength(1);
		expect(thinking[0]).toEqual({
			kind: "thinking",
			id: "00000000-0000-4000-8000-000000000042:thinking",
			timestamp: Date.parse("2026-07-18T01:49:01.895Z"),
			text: "I need to dispatch a triager for each of the two issues, running them in parallel.",
		});
	});

	it("keeps the turn's own text as its own assistant item, ahead of nothing it invented", () => {
		expect(items(events).map((one) => one.kind)).toEqual(["thinking", "assistant"]);
		expect(items(events)[1]).toMatchObject({
			kind: "assistant",
			id: "00000000-0000-4000-8000-000000000044",
			text: "Two issues — one triager each, in parallel.",
		});
	});

	/**
	 * No committed capture holds a `redacted_thinking` block: it appears only when the provider
	 * withholds a turn's reasoning, which no run can force (`fixtures/PROVENANCE.md`). So this case
	 * is the golden thinking frame with that one block's `type` and payload field swapped for the
	 * redacted shape the Messages API documents — `{type, data}`, the content encrypted — and every
	 * other key left as captured.
	 */
	it("reads a withheld block as a thinking item saying so, rather than dropping it", () => {
		const captured = (loadFixture("thinking-turn") as ReadonlyArray<Record<string, unknown>>)[0];
		expect(captured).toBeDefined();
		const withheld = {
			...captured,
			message: {
				...(captured?.message as Record<string, unknown>),
				content: [{type: "redacted_thinking", data: "EroBCkYIBRgCKkBt7Xo="}],
			},
		} as SDKMessage;
		const thinking = items(run([withheld]).events).filter((one) => one.kind === "thinking");
		expect(thinking).toHaveLength(1);
		expect(thinking[0]).toMatchObject({text: "(the provider withheld this reasoning)"});
	});
});

describe("toAgentEvents over a captured compaction boundary", () => {
	it("marks where the session compacted, with the trigger and what it cost", () => {
		const {events} = run([message("compact-boundary")]);
		expect(events).toEqual([
			{
				kind: "item",
				item: {
					kind: "compaction",
					id: "00000000-0000-4000-8000-000000000045",
					timestamp: AT,
					text: "context compacted (manual): 337818 tokens before, 13932 after",
				},
			},
		]);
	});
});

describe("toAgentEvents over the session notices", () => {
	it("collapses a captured informational frame into one system row with its detail folded", () => {
		const {events} = run([message("informational-notice")]);
		const notices = items(events);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({
			kind: "system",
			id: "00000000-0000-4000-8000-000000000050",
			text: "informational: Usage limit reached · continuing automatically at 3:30am · esc or type to cancel",
		});
		expect(notices[0]?.kind === "system" && notices[0].detail).toBe(
			JSON.stringify(
				{
					content:
						"Usage limit reached · continuing automatically at 3:30am · esc or type to cancel",
					level: "notice",
				},
				null,
				2,
			),
		);
	});

	it("collapses the captured rate-limit frame the same way, which used to be a silent skip", () => {
		const step = toAgentEvents(message("unknown-message"), emptyMapping, {at: AT});
		expect(step.mapping.skipped).toBe(0);
		expect(items(step.events)).toMatchObject([{kind: "system", text: "rate limit event"}]);
		const notice = items(step.events)[0];
		expect(
			notice?.kind === "system" && notice.detail?.includes('"rateLimitType": "five_hour"'),
		).toBe(true);
	});
});

describe("toAgentEvents over a captured streaming turn", () => {
	const stream = messages("streaming-turn");
	const {events, mapping} = run(stream);
	const MSG = "msg_00000000000000000006";

	it("grows one assistant item across every delta instead of a row apiece", () => {
		const assistants = items(events).filter((one) => one.kind === "assistant");
		expect(assistants.length).toBeGreaterThan(1);
		expect(new Set(assistants.map((one) => one.id))).toEqual(new Set([MSG]));
		expect(assistants.map((one) => one.kind === "assistant" && one.text)).toEqual([
			"h",
			"hello from",
			"hello from tu",
			"hello from tuval streaming cap",
			"hello from tuval streaming capture",
			"hello from tuval streaming capture",
		]);
	});

	// The id is the `msg_*` the wrapped `message_start` announced. Every frame here also carries its
	// own per-delta `uuid`, and keying on that is the failure this case exists to catch.
	it("keys the row on the turn's message id, never on the frame's own uuid", () => {
		const frameUuids = new Set(
			stream.flatMap((one) => (one.type === "stream_event" ? [one.uuid as string] : [])),
		);
		const assistants = items(events).filter((one) => one.kind === "assistant");
		expect(assistants.filter((one) => frameUuids.has(one.id))).toEqual([]);
	});

	it("folds the deltas and the finished message into exactly one row, no longer partial", () => {
		const folded = new Map(
			items(events)
				.filter((one) => one.kind === "assistant")
				.map((one) => [one.id, one]),
		);
		expect([...folded.keys()]).toEqual([MSG]);
		expect(folded.get(MSG as ItemId)).toEqual({
			kind: "assistant",
			id: MSG,
			timestamp: AT,
			text: "hello from tuval streaming capture",
		});
		expect(mapping.partial).toBeNull();
	});

	it("marks every row but the last as still being written", () => {
		const assistants = items(events).filter((one) => one.kind === "assistant");
		expect(assistants.map((one) => one.kind === "assistant" && one.partial)).toEqual([
			...assistants.slice(0, -1).map(() => true),
			undefined,
		]);
	});

	/**
	 * The whole no-regression claim of turning `includePartialMessages` on: `sdk.d.ts` warns that a
	 * streamed turn's finished `assistant` frame "typically holds the single block this message
	 * delivers and `stop_reason` is still null" (0.3.259, `SDKAssistantMessage`). This capture has
	 * exactly that shape, and the transcript it folds to is the one a non-streaming turn produces.
	 */
	it("folds to the transcript this same turn produces with the flag off", () => {
		const whole = run(stream.filter((one) => one.type !== "stream_event"));
		// Everything but the row's key and its clock, which streaming does move: a streamed row is
		// keyed on the turn's `msg_*` and stamped at the delta that opened it.
		const folded = (all: ReadonlyArray<AgentEvent>) =>
			[...new Map(items(all).map((one) => [one.id, one])).values()].map(
				({id: _id, timestamp: _timestamp, ...rest}) => ({...rest, partial: undefined}),
			);
		expect(folded(events)).toEqual(folded(whole.events));
		expect(whole.events.filter((one) => one.kind === "usage")).toEqual(
			events.filter((one) => one.kind === "usage"),
		);
	});
});

describe("toAgentEvents over a thinking delta", () => {
	/**
	 * `streaming-turn` holds no reasoning of its own — whether a turn reasons is the provider's call,
	 * not a run's (`fixtures/PROVENANCE.md`). So this stamps the delta the SDK declares — a
	 * `thinking_delta` carrying `thinking` — over that capture's own deltas, and every other frame
	 * stays the captured shape. The reasoning stream `subagent-turn` did capture is below.
	 */
	const reasoning = (stream: ReadonlyArray<SDKMessage>): ReadonlyArray<SDKMessage> =>
		stream.map((one) =>
			one.type === "stream_event" && one.event.type === "content_block_delta"
				? ({
						...one,
						event: {...one.event, delta: {type: "thinking_delta", thinking: "let me think"}},
					} as SDKMessage)
				: one,
		);

	it("never lets reasoning reach the reply as assistant text", () => {
		const {events} = run(reasoning(messages("streaming-turn")));
		const assistants = items(events).filter((one) => one.kind === "assistant");
		expect(assistants.map((one) => one.kind === "assistant" && one.text)).toEqual([
			"hello from tuval streaming capture",
		]);
		expect(assistants.map((one) => one.kind === "assistant" && one.partial)).toEqual([undefined]);
	});
});

describe("toAgentEvents over a streamed turn that reasons before it answers", () => {
	/**
	 * The shape `sdk.d.ts` documents and no capture can force: "while a response streams the CLI
	 * emits one assistant message per completed content block, so several consecutive assistant
	 * messages can share message.id" (0.3.259, `SDKAssistantMessage`). Whether a turn reasons is the
	 * provider's call, so this stamps a thinking block — its `content_block_start`, a
	 * `thinking_delta`, a `signature_delta` and its own `assistant` frame — ahead of the golden
	 * streaming turn's text block, over that same capture's own frames. Every other frame stays the
	 * captured shape, and the text block's frames are untouched.
	 */
	const MSG = "msg_00000000000000000006";
	const stream = messages("streaming-turn");
	const only = <T>(rows: ReadonlyArray<T>, what: string): T => {
		const first = rows[0];
		if (first === undefined) throw new Error(`the capture holds no ${what} frame`);
		return first;
	};
	const envelope = only(
		stream.flatMap((one) => (one.type === "stream_event" ? [one] : [])),
		"stream_event",
	);
	const finished = only(
		stream.flatMap((one) => (one.type === "assistant" ? [one] : [])),
		"assistant",
	);
	const streamed = (event: unknown): SDKMessage => {
		const frame: unknown = {...envelope, event};
		return frame as SDKMessage;
	};
	const thinkingBlock = {type: "thinking", thinking: "let me think", signature: "sig"};
	const thinkingFrame: unknown = {
		...finished,
		uuid: "00000000-0000-4000-8000-000000000015",
		message: {...finished.message, content: [thinkingBlock]},
	};
	const thinkingFirst: ReadonlyArray<SDKMessage> = stream.flatMap((one) =>
		one.type === "stream_event" && one.event.type === "content_block_start"
			? [
					streamed({
						type: "content_block_start",
						index: 0,
						content_block: {type: "thinking", thinking: "", signature: ""},
					}),
					streamed({
						type: "content_block_delta",
						index: 0,
						delta: {type: "thinking_delta", thinking: "let me think"},
					}),
					streamed({
						type: "content_block_delta",
						index: 0,
						delta: {type: "signature_delta", signature: "sig"},
					}),
					streamed({type: "content_block_stop", index: 0}),
					thinkingFrame as SDKMessage,
					one,
				]
			: [one],
	);
	const {events, mapping} = run(thinkingFirst);
	const assistants = () => items(events).filter((one) => one.kind === "assistant");

	it("still streams the answer, keyed on the turn's message id", () => {
		expect(new Set(assistants().map((one) => one.id))).toEqual(new Set([MSG]));
		expect(assistants().map((one) => one.kind === "assistant" && one.text)).toEqual([
			"h",
			"hello from",
			"hello from tu",
			"hello from tuval streaming cap",
			"hello from tuval streaming capture",
			"hello from tuval streaming capture",
		]);
	});

	// The thinking block's own `assistant` frame is the one that used to close the reply, which left
	// the answer keyed on that frame's uuid with no delta ever reaching the screen.
	it("keys no reply row on any frame's own uuid", () => {
		const frameUuids = new Set(thinkingFirst.map((one) => one.uuid as string));
		const replies = items(events).filter(
			(one) => one.kind === "assistant" || one.kind === "thinking",
		);
		expect(replies.filter((one) => frameUuids.has(one.id))).toEqual([]);
	});

	it("folds to one settled assistant row beside the turn's reasoning", () => {
		const folded = new Map(items(events).map((one) => [one.id, one]));
		expect(folded.get(MSG as ItemId)).toEqual({
			kind: "assistant",
			id: MSG,
			timestamp: AT,
			text: "hello from tuval streaming capture",
		});
		expect(folded.get(`${MSG}:thinking` as ItemId)).toMatchObject({
			kind: "thinking",
			text: "let me think",
		});
		expect(mapping.partial).toBeNull();
	});

	it("marks every row but the last as still being written", () => {
		expect(assistants().map((one) => one.kind === "assistant" && one.partial)).toEqual([
			...assistants()
				.slice(0, -1)
				.map(() => true),
			undefined,
		]);
	});
});

describe("toAgentEvents over a streamed turn whose assistant frame lands after the close", () => {
	/**
	 * Arrival order is the only variable here. Every envelope is the committed streaming turn's own,
	 * and the turn's `assistant` frame is lifted out of its captured slot — mid-stream, where it
	 * folds into the open reply — to after `message_stop`, where the reply has already settled. No
	 * capture exhibits that ordering: the founder's sighting of the doubled row was not captured,
	 * and nothing proves the SDK ever delivers the frame that late. The mapping holds on either
	 * order because a frame naming a settled `msg_*` belongs on that row whatever the SDK does
	 * (#8366).
	 */
	const MSG = "msg_00000000000000000006";
	const stream = messages("streaming-turn");
	const captured = <T extends SDKMessage>(rows: ReadonlyArray<T>, what: string): T => {
		const first = rows[0];
		if (first === undefined) throw new Error(`the capture holds no ${what} frame`);
		return first;
	};
	const finished = captured(
		stream.flatMap((one) => (one.type === "assistant" ? [one] : [])),
		"assistant",
	);
	/** The capture with its `assistant` frame moved past `message_stop`, `between` in the gap. */
	const late = (
		frame: SDKMessage = finished,
		between: ReadonlyArray<SDKMessage> = [],
	): ReadonlyArray<SDKMessage> =>
		stream.flatMap((one) =>
			one.type === "assistant"
				? []
				: one.type === "stream_event" && one.event.type === "message_stop"
					? [one, ...between, frame]
					: [one],
		);

	it("lands the frame on the settled row instead of a second copy of the answer", () => {
		const {events} = run(late());
		const replies = tail(events).filter((one) => one.kind === "assistant");
		expect(replies).toEqual([
			{kind: "assistant", id: MSG, timestamp: AT, text: "hello from tuval streaming capture"},
		]);
	});

	it("keeps the reply above a tool row that landed while the frame was in flight", () => {
		// The tool row is the `tool-turn` capture's own `tool_use` frame, so the gap is filled by a
		// real envelope rather than an invented one; only where it sits is this case's doing.
		const tool = captured(
			messages("tool-turn").flatMap((one) => (one.type === "assistant" ? [one] : [])),
			"tool_use",
		);
		const {events} = run(late(finished, [tool]));
		const rows = tail(events).filter((one) => one.kind === "assistant" || one.kind === "tool");
		expect(rows.map((one) => one.kind)).toEqual(["assistant", "tool"]);
		expect(rows[0]).toEqual({
			kind: "assistant",
			id: MSG,
			timestamp: AT,
			text: "hello from tuval streaming capture",
		});
	});

	/**
	 * The frame carries `thinking-turn`'s captured reasoning block in place of the streaming turn's
	 * text block — two captures crossed, because whether a turn reasons is the provider's call and
	 * no single capture holds both shapes (`fixtures/PROVENANCE.md`). Nothing here is invented: the
	 * envelope and the block are both captured bytes, and the ordering stays this case's variable.
	 */
	it("hangs a late reasoning block off the settled row's id", () => {
		const reasoned = captured(
			messages("thinking-turn").flatMap((one) => (one.type === "assistant" ? [one] : [])),
			"thinking",
		);
		const frame: unknown = {
			...finished,
			message: {...finished.message, content: reasoned.message.content},
		};
		const {events} = run(late(frame as SDKMessage));
		const thinking = tail(events).filter((one) => one.kind === "thinking");
		expect(thinking.map((one) => one.id)).toEqual([`${MSG}:thinking`]);
		expect(thinking[0]?.timestamp).toBe(AT);
	});
});

describe("toAgentEvents over a message it has no shape for", () => {
	it("counts a delta that reached it with no message_start to key a row on", () => {
		const partial: unknown = {
			type: "stream_event",
			event: {type: "content_block_delta", delta: {type: "text_delta", text: "hel"}},
			session_id: "s",
			uuid: "u",
			parent_tool_use_id: null,
		};
		const step = toAgentEvents(partial as SDKMessage, emptyMapping, {at: AT});
		expect(step.events).toEqual([]);
		expect(step.mapping.skipped).toBe(1);
	});
});

describe("toAgentEvents is pure", () => {
	it("answers the same twice and leaves the mapping it was handed alone", () => {
		const mapping = emptyMapping;
		const first = run(messages("tool-turn"), mapping);
		const second = run(messages("tool-turn"), mapping);
		expect(first.events).toEqual(second.events);
		expect(mapping.toolCalls.size).toBe(0);
		expect(mapping.skipped).toBe(0);
	});
});

describe("toAgentEvents over a captured subagent turn", () => {
	const {events} = run(messages("subagent-turn"));
	const SPAWN = "toolu_000000000000000000000001";
	const slots = events.flatMap((one) => (one.kind === "subagent" ? [one.slot] : []));
	// The folded transcript rather than the raw events, which carry a tool row twice: once running,
	// once settled.
	const inside = tail(events).filter((one) => one.parentId === SPAWN);

	it("tags the worker's reasoning and its prose with the call that spawned them", () => {
		expect(inside.filter((one) => one.kind === "thinking")).toHaveLength(1);
		const prose = inside.filter((one) => one.kind === "assistant");
		expect(prose.length).toBeGreaterThan(0);
		expect(prose.map((one) => one.parentId)).toEqual(prose.map(() => SPAWN));
	});

	it("tags the worker's own inbound turn, which landed top-level on the desk run", () => {
		const prompts = inside.filter((one) => one.kind === "user");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.kind === "user" && prompts[0].text.startsWith("Read pantry.txt")).toBe(true);
	});

	it("leaves the agent's own reasoning, prose and tool calls untagged", () => {
		const own = tail(events).filter((one) => one.parentId === undefined);
		expect(own.map((one) => one.kind)).toContain("thinking");
		expect(own.map((one) => one.kind)).toContain("assistant");
		expect(own.flatMap((one) => (one.kind === "tool" ? [one.name] : []))).toEqual(["Agent"]);
	});

	it("opens the slot at the spawning call, with that call's id, type and clock", () => {
		const opened = slots.find((one) => one.id === SPAWN);
		const call = tail(events).find((one) => one.id === SPAWN);
		expect(opened).toMatchObject({type: "general-purpose", status: "running", tokens: 0});
		expect(opened?.startedAt).toBe(call?.timestamp);
	});

	it("follows the newest nested line and grows the token count off the nested frames", () => {
		const running = slots.filter((one) => one.status === "running");
		const tokens = running.map((one) => one.tokens);
		expect(running.at(-1)?.lastLine).toBe("**Word:** `zeytinyagi` — 10 letters.");
		// The backend's own `task_notification` for this worker reads 25,508.
		expect(running.at(-1)?.tokens).toBe(25_229);
		expect(tokens).toEqual([...tokens].sort((a, b) => a - b));
	});

	it("admits every item kind the worker produced, in arrival order, one entry each", () => {
		const held = slots.at(-1)?.items ?? [];
		expect(held.map((one) => one.kind)).toEqual([
			"user",
			"assistant",
			"tool",
			"thinking",
			"assistant",
		]);
		// The worker's one call opens `running` and settles `ok` under one id; the slot holds the
		// settled row where the running one was, exactly as the transcript does.
		expect(new Set(held.map((one) => one.id)).size).toBe(held.length);
		expect(held.flatMap((one) => (one.kind === "tool" ? [one.status] : []))).toEqual(["ok"]);
	});

	it("marks the slot finished when the spawning call settles, and moves nothing after (Q2)", () => {
		const finished = slots.filter((one) => one.status === "finished");
		expect(finished).toHaveLength(1);
		expect(slots.at(-1)?.status).toBe("finished");
		const last = slots.filter((one) => one.status === "running").at(-1);
		expect(finished[0]).toEqual({...last, status: "finished"});
	});

	it("emits slots the port admits", () => {
		expect(slots.length).toBeGreaterThan(0);
		expect(slots.every(isSubagentSlot)).toBe(true);
	});
});

describe("toAgentEvents over a subagent's streamed reply", () => {
	/**
	 * The one part of a nested turn no capture holds: `subagent-turn.json` shows the CLI forwards a
	 * worker's frames whole and streams none of them, so a nested `stream_event` run cannot be forced
	 * from a query. `SDKPartialAssistantMessage` declares `parent_tool_use_id: string | null` exactly
	 * as the assistant and user frames do (`sdk.d.ts`, 0.3.259), so this is the golden
	 * `streaming-turn` stream with that one field stamped over it and every other key untouched.
	 */
	const PARENT = "toolu_01SubagentParent";
	const nested = messages("streaming-turn").map((one) =>
		one.type === "stream_event" || one.type === "assistant"
			? ({...one, parent_tool_use_id: PARENT} as SDKMessage)
			: one,
	);

	it("tags every upsert of the growing reply, and the settled row that replaces them", () => {
		const replies = items(run(nested).events).filter((one) => one.kind === "assistant");
		expect(replies.length).toBeGreaterThan(1);
		expect(replies.map((one) => one.parentId)).toEqual(replies.map(() => PARENT));
		expect(replies.filter((one) => one.partial !== true).length).toBeGreaterThan(0);
	});

	it("leaves the captured top-level stream's upserts carrying no parent at all", () => {
		const replies = items(run(messages("streaming-turn")).events).filter(
			(one) => one.kind === "assistant",
		);
		expect(replies.map((one) => "parentId" in one)).toEqual(replies.map(() => false));
	});
});

describe("toAgentEvents over the one captured stream that reasons", () => {
	/**
	 * `subagent-turn.json` is it: `content_block_start` on a `thinking` block, two `thinking_delta`
	 * frames, a `signature_delta`, then that block's own `assistant` frame. Every one of those deltas
	 * carries an empty `thinking` — the provider ships this pin's reasoning encrypted, in both wire
	 * forms and in every capture (`fixtures/PROVENANCE.md`) — so what the capture proves is the
	 * withheld half. The plaintext half is stamped over these same frames in the case below.
	 */
	const MSG = "msg_000000000000000000000001";
	const {events, mapping} = run(messages("subagent-turn"));
	const reasoning = tail(events).filter(
		(one) => one.kind === "thinking" && one.parentId === undefined,
	);

	it("draws no growing row for withheld reasoning, and settles the row that says it was", () => {
		expect(reasoning).toEqual([
			{
				kind: "thinking",
				id: `${MSG}:thinking`,
				timestamp: AT,
				text: "(the provider withheld this reasoning)",
			},
		]);
	});

	it("keeps the block's signature out of every row, reasoning or reply", () => {
		expect(JSON.stringify(items(events))).not.toContain("SIGNATURE-PLACEHOLDER");
		expect(mapping.thinking).toBe("");
	});
});

/**
 * The captured reasoning stream with plaintext where the encrypted reasoning was: the two
 * `thinking_delta` frames of `subagent-turn.json` and the `thinking` block of the `assistant` frame
 * that settles them. Nothing else is touched — the envelopes, the block boundaries and the arrival
 * order are the capture's — and no run can force the plaintext (`fixtures/PROVENANCE.md`).
 */
const REASONED = ["let me ", "weigh it"];

const carriesThinking = (one: SDKMessage): boolean =>
	one.type === "assistant" &&
	Array.isArray(one.message.content) &&
	one.message.content.some((block) => block.type === "thinking");

const spokenAloud = (stream: ReadonlyArray<SDKMessage>): ReadonlyArray<SDKMessage> => {
	let next = 0;
	return stream.map((one) => {
		if (
			one.type === "stream_event" &&
			one.event.type === "content_block_delta" &&
			one.event.delta.type === "thinking_delta"
		) {
			const thinking = REASONED[next] ?? "";
			next += 1;
			return {...one, event: {...one.event, delta: {...one.event.delta, thinking}}} as SDKMessage;
		}
		if (one.type !== "assistant" || !carriesThinking(one)) return one;
		return {
			...one,
			message: {
				...one.message,
				content: one.message.content.map((block) =>
					block.type === "thinking" ? {...block, thinking: REASONED.join("")} : block,
				),
			},
		} as SDKMessage;
	});
};

describe("toAgentEvents over a streamed reasoning block that is not withheld", () => {
	const MSG = "msg_000000000000000000000001";
	const ANSWER = "msg_000000000000000000000004";
	const {events, mapping} = run(spokenAloud(messages("subagent-turn")));
	const reasoning = items(events).filter(
		(one) => one.kind === "thinking" && one.parentId === undefined,
	);

	it("grows one reasoning row across the deltas instead of a row apiece", () => {
		expect(new Set(reasoning.map((one) => one.id))).toEqual(new Set([`${MSG}:thinking`]));
		expect(reasoning.map((one) => one.kind === "thinking" && one.text)).toEqual([
			"let me ",
			"let me weigh it",
			"let me weigh it",
		]);
	});

	it("holds the row's clock and its parent through the growth and the settle", () => {
		expect(reasoning.map((one) => one.timestamp)).toEqual(reasoning.map(() => AT));
		expect(reasoning.map((one) => "parentId" in one)).toEqual(reasoning.map(() => false));
	});

	it("marks every row but the settled one as still being written", () => {
		expect(reasoning.map((one) => one.kind === "thinking" && one.partial)).toEqual([
			true,
			true,
			undefined,
		]);
	});

	it("keeps the reasoning out of the reply, and still streams the answer that follows it", () => {
		const replies = items(events).filter(
			(one) => one.kind === "assistant" && one.parentId === undefined,
		);
		expect(replies.every((one) => one.kind === "assistant" && !one.text.includes("weigh it"))).toBe(
			true,
		);
		const answer = tail(events).find((one) => one.id === ANSWER);
		expect(answer?.kind === "assistant" && answer.text.startsWith("Subagent's answer:")).toBe(true);
		expect(answer !== undefined && !("partial" in answer)).toBe(true);
	});

	it("leaves nothing partial once the stream has ended", () => {
		expect(tail(events).filter((one) => "partial" in one && one.partial === true)).toEqual([]);
		expect(mapping.thinking).toBe("");
		expect(mapping.partial).toBeNull();
	});
});

describe("toAgentEvents over reasoning no assistant frame ever settles", () => {
	/**
	 * The stamped stream with the frame that carries the reasoning block dropped, which is what a
	 * turn cut inside the block leaves: nothing downstream settles the row the deltas drew, and a row
	 * left marked partial is one nothing checkpoints past for the rest of the session (#8170).
	 * Dropping that frame is this case's only variable.
	 */
	const MSG = "msg_000000000000000000000001";
	const stream = spokenAloud(messages("subagent-turn")).filter((one) => !carriesThinking(one));
	const ownReasoning = (events: ReadonlyArray<AgentEvent>) =>
		tail(events).filter((one) => one.kind === "thinking" && one.parentId === undefined);

	it("settles the row at the text the deltas wrote when the stream ends", () => {
		const {events, mapping} = run(stream);
		expect(ownReasoning(events)).toEqual([
			{kind: "thinking", id: `${MSG}:thinking`, timestamp: AT, text: "let me weigh it"},
		]);
		expect(mapping.thinking).toBe("");
	});

	it("settles it on the frame that cut the turn instead, when one arrives first", () => {
		// `aborted` is the SDK's mark for a message the stream cut mid-word. The frame is the
		// capture's own, of this same turn; only the mark is stamped.
		const cut = stream.map((one) =>
			one.type === "assistant" && one.message.id === MSG
				? ({...one, aborted: true} as SDKMessage)
				: one,
		);
		const {events, mapping} = run(cut);
		expect(ownReasoning(events)).toEqual([
			{kind: "thinking", id: `${MSG}:thinking`, timestamp: AT, text: "let me weigh it"},
		]);
		expect(mapping.thinking).toBe("");
	});
});

describe("toAgentEvents over a subagent's streamed reasoning", () => {
	/**
	 * A worker's reply is forwarded whole and never streamed, so no run can force a nested
	 * `stream_event` (`fixtures/PROVENANCE.md`). `SDKPartialAssistantMessage` declares
	 * `parent_tool_use_id: string | null` exactly as an assistant frame does (`sdk.d.ts`, 0.3.259),
	 * so this is the stamped reasoning stream with that one field stamped over it as well.
	 */
	const PARENT = "toolu_01SubagentParent";
	const nested = spokenAloud(messages("subagent-turn")).map((one) =>
		one.type === "stream_event" || one.type === "assistant"
			? ({...one, parent_tool_use_id: PARENT} as SDKMessage)
			: one,
	);

	it("tags every upsert of the growing reasoning, and the settled row that replaces them", () => {
		const reasoning = items(run(nested).events).filter((one) => one.kind === "thinking");
		expect(reasoning.length).toBeGreaterThan(1);
		expect(reasoning.map((one) => one.parentId)).toEqual(reasoning.map(() => PARENT));
		expect(
			reasoning.filter((one) => one.kind === "thinking" && one.partial !== true).length,
		).toBeGreaterThan(0);
	});
});
