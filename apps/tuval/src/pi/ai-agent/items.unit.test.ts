/**
 * The revision fold, over hand-built wire values rather than a live session: this is the one place
 * a Pi snapshot becomes something the window can render, so every case it has to get right is
 * cheaper to pin here than to provoke out of a model.
 */

import type {
	TranscriptItem as PiTranscriptItem,
	SessionSnapshot,
} from "@earendil-works/pi-protocol";
import {describe, expect, it} from "vitest";
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
