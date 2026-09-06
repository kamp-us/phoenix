/**
 * The revision fold, over hand-built wire values rather than a live session: this is the one place
 * a Pi snapshot becomes something the window can render, so every case it has to get right is
 * cheaper to pin here than to provoke out of a model.
 */

import {applyCellChecked} from "@demlik/tea";
import type {
	TranscriptItem as PiTranscriptItem,
	SessionSnapshot,
} from "@earendil-works/pi-protocol";
import {describe, expect, it} from "vitest";
import {
	type AiAgentSessionCmd,
	type AiAgentSessionMsg,
	type AiAgentSessionState,
	aiAgentSessionMachine,
	initialState,
} from "../../ai-agent/core/index.ts";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {TOOL_RESULT_BYTE_LIMIT} from "../../ai-agent/ports/index.ts";
import {emptyProjection, eventsOf, itemOf, phaseOf} from "./items.ts";

const usage = (total: number) => ({
	input: 11,
	output: 22,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 33,
	cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total},
});

const snapshot = (
	transcript: ReadonlyArray<PiTranscriptItem>,
	phase: SessionSnapshot["phase"] = "idle",
	revision = 1,
): SessionSnapshot => ({
	id: "session-7602",
	cwd: "/workspace",
	createdAt: 0,
	updatedAt: 0,
	phase,
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
	attached: true,
	locked: false,
	revision,
	transcript: [...transcript],
	queuedSteer: [],
	queuedSteerCount: 0,
});

const user: PiTranscriptItem = {
	id: "item-0",
	role: "user",
	content: [{type: "text", text: "say hello"}],
	timestamp: 10,
};

const assistant = (text: string, total = 0): PiTranscriptItem => ({
	id: "item-1",
	role: "assistant",
	content: [
		{type: "thinking", thinking: "not for the window"},
		{type: "text", text},
	],
	model: {provider: "faux", id: "faux-1"},
	usage: usage(total),
	timestamp: 11,
	status: "complete",
	stopReason: "stop",
});

const runningTool: PiTranscriptItem = {
	id: "item-2",
	role: "tool",
	toolCallId: "call-1",
	toolName: "read_file",
	input: {path: "README.md"},
	content: [],
	timestamp: 12,
	status: "running",
	isError: false,
};

const settledTool: PiTranscriptItem = {
	...runningTool,
	content: [{type: "text", text: "the file"}],
	status: "complete",
	isError: false,
};

describe("one wire item as a port item", () => {
	it("keeps a user turn's text and drops nothing else", () => {
		expect(itemOf(user)).toEqual({kind: "user", id: "item-0", timestamp: 10, text: "say hello"});
	});

	it("leaves an assistant turn's thinking out of the text it renders", () => {
		expect(itemOf(assistant("hi back"))).toEqual({
			kind: "assistant",
			id: "item-1",
			timestamp: 11,
			text: "hi back",
		});
	});

	it("marks an aborted turn interrupted", () => {
		const aborted: PiTranscriptItem = {
			id: "item-1",
			role: "assistant",
			content: [{type: "text", text: "half a th"}],
			model: {provider: "faux", id: "faux-1"},
			timestamp: 11,
			status: "aborted",
			stopReason: "aborted",
		};
		expect(itemOf(aborted)).toEqual({
			kind: "assistant",
			id: "item-1",
			timestamp: 11,
			text: "half a th",
			interrupted: true,
		});
	});

	it("keys a tool row by its call id and folds the three wire statuses", () => {
		expect(itemOf(runningTool)).toEqual({
			kind: "tool",
			id: "call-1",
			timestamp: 12,
			name: "read_file",
			input: {path: "README.md"},
			result: {text: "", omitted: {bytes: 0}},
			status: "running",
		});
		expect(itemOf(settledTool)).toMatchObject({id: "call-1", status: "ok"});
		expect(itemOf({...settledTool, status: "error", isError: true})).toMatchObject({
			status: "error",
		});
	});

	it("bounds a tool result at the port's byte limit", () => {
		const long = {...settledTool, content: [{type: "text" as const, text: "x".repeat(20_000)}]};
		const bounded = itemOf(long);
		expect(bounded.kind).toBe("tool");
		if (bounded.kind !== "tool") return;
		expect(bounded.result.text.length).toBeLessThanOrEqual(TOOL_RESULT_BYTE_LIMIT);
		expect(bounded.result.omitted.bytes).toBeGreaterThan(0);
	});
});

describe("Pi's phases against the core's", () => {
	it("reads idle as ready and every busy phase as prompting", () => {
		expect(phaseOf("idle")).toBe("ready");
		const busy: ReadonlyArray<SessionSnapshot["phase"]> = [
			"turn",
			"compaction",
			"branch_summary",
			"retry",
		];
		expect(busy.map(phaseOf)).toEqual(["prompting", "prompting", "prompting", "prompting"]);
	});
});

describe("one revision folded into events", () => {
	it("emits every item, then usage, then the phase", () => {
		const folded = eventsOf(emptyProjection, snapshot([user, assistant("hi back", 0.42)], "idle"));
		expect(folded.events.map((event) => event.kind)).toEqual(["item", "item", "usage", "phase"]);
		expect(folded.events.at(-2)).toEqual({
			kind: "usage",
			model: "faux/faux-1",
			inputTokens: 11,
			outputTokens: 22,
			cost: 0.42,
		});
		expect(folded.events.at(-1)).toEqual({kind: "phase", phase: "ready"});
	});

	it("re-emits nothing when the next revision changed nothing", () => {
		const first = eventsOf(emptyProjection, snapshot([user, assistant("hi back")]));
		const second = eventsOf(first.next, snapshot([user, assistant("hi back")], "idle", 2));
		expect(second.events).toEqual([]);
	});

	it("re-sends a tool row under the same id when its result lands", () => {
		const first = eventsOf(emptyProjection, snapshot([user, runningTool], "turn"));
		const second = eventsOf(first.next, snapshot([user, settledTool], "idle", 2));
		expect(second.events).toEqual([
			{kind: "item", item: itemOf(settledTool)},
			{kind: "phase", phase: "ready"},
		]);
	});
});

/**
 * Pi's half of #8007: asking for an abort leaves the session busy, and the confirming event is this
 * fan's own — the next revision reports the session back at `idle`, which `phaseOf` reads as `ready`.
 * Folded through the real core, because a mapping that reads right over a core still stuck at
 * `prompting` would have proved nothing.
 */
describe("an interruption over the Pi event path", () => {
	const machine = aiAgentSessionMachine({cwd: "/workspace"});
	const SENT_AT = 1_700_000_000_000;

	const apply = (
		state: AiAgentSessionState,
		msg: AiAgentSessionMsg,
	): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
		applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(
			machine,
			state,
			msg,
		);

	const fold = (
		state: AiAgentSessionState,
		events: ReadonlyArray<AgentEvent>,
	): AiAgentSessionState =>
		events.reduce(
			(carried, event) => apply(carried, {type: "event", sessionId: "session-7602", event})[0],
			state,
		);

	/** A session mid-turn with the abort already asked for. */
	const asked = (): {
		readonly state: AiAgentSessionState;
		readonly running: ReturnType<typeof eventsOf>["next"];
	} => {
		const running = eventsOf(emptyProjection, snapshot([user], "turn"));
		const opened: AiAgentSessionState = {
			...initialState("/workspace"),
			phase: "ready",
			sessionId: "session-7602",
		};
		const [prompting] = apply(opened, {
			type: "prompt",
			text: "say hello",
			key: "k1",
			timestamp: SENT_AT,
		});
		const [state] = apply(fold(prompting, running.events), {type: "interrupt", at: SENT_AT + 1});
		return {state, running: running.next};
	};

	it("stays busy with the request outstanding while Pi still reports the turn", () => {
		const {state, running} = asked();
		const next = eventsOf(running, snapshot([user, assistant("still going")], "turn", 2));
		const after = fold(state, next.events);
		expect(after.phase).toBe("prompting");
		expect(after.interruption).toEqual({requestedAt: SENT_AT + 1});
	});

	it("comes back to ready on the revision that reports the session idle", () => {
		const {state, running} = asked();
		const settled = eventsOf(running, snapshot([user, assistant("hi back")], "idle", 2));
		expect(settled.events).toContainEqual({kind: "phase", phase: "ready"});
		const after = fold(state, settled.events);
		expect(after.phase).toBe("ready");
		expect(after.interruption).toBeNull();
	});
});
