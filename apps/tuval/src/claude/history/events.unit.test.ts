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
import type {AgentEvent} from "../../ai-agent/events.ts";
import {byteLength, TOOL_RESULT_BYTE_LIMIT} from "../../ai-agent/ports/index.ts";
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

describe("toAgentEvents over a captured init", () => {
	it("reports the model the session named, and no phase", () => {
		const {events, mapping} = run([message("init")]);
		expect(events).toEqual([
			{kind: "usage", model: "claude-fable-5-1", inputTokens: 0, outputTokens: 0, cost: 0},
		]);
		expect(mapping.model).toBe("claude-fable-5-1");
	});

	it("reads a resumed session's init the same way", () => {
		const {events} = run([message("resumed-init")]);
		expect(events).toEqual([
			{kind: "usage", model: "claude-fable-5-1", inputTokens: 0, outputTokens: 0, cost: 0},
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

describe("toAgentEvents over a message it has no shape for", () => {
	it("counts a partial assistant frame, so streaming stays whole-message", () => {
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
