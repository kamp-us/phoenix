/**
 * Driven by `fixtures/session-messages.json` — the rows `getSessionMessages` actually returned for
 * the same session `fixtures/tool-turn.json` was streamed from, so the two fixtures are one
 * conversation read through both wire forms.
 */

import type {SDKAssistantMessage, SDKMessage, SessionMessage} from "@anthropic-ai/claude-agent-sdk";
import {describe, expect, it} from "vitest";
import {planTranscriptPage} from "../../ai-agent/history/page.ts";
import {toAgentEvents} from "./events.ts";
import {loadFixture} from "./fixtures/load.ts";
import {toHistoryItems} from "./items.ts";
import {emptyMapping} from "./map.ts";

const AT = 1_700_000_000_000;
const rows = loadFixture("session-messages") as ReadonlyArray<SessionMessage>;

describe("toHistoryItems over a captured session", () => {
	const {items, skipped} = toHistoryItems(rows, {at: AT});

	it("returns the turn oldest first, one item per thing that happened", () => {
		expect(items.map((one) => one.kind)).toEqual(["user", "tool", "assistant"]);
		expect(items.map((one) => one.timestamp)).toEqual([
			Date.parse("2026-09-04T18:23:21.494Z"),
			Date.parse("2026-09-04T18:23:24.205Z"),
			Date.parse("2026-09-04T18:23:26.379Z"),
		]);
		expect(skipped).toBe(0);
	});

	it("folds the tool_use and its tool_result into one settled row", () => {
		const tool = items.find((one) => one.kind === "tool");
		expect(tool).toBeDefined();
		expect(tool).toEqual({
			kind: "tool",
			id: "toolu_00000000000000000010",
			timestamp: Date.parse("2026-09-04T18:23:24.205Z"),
			name: "Bash",
			input: {command: "echo hello-tuval", description: "Echo hello-tuval"},
			status: "ok",
			result: {text: "hello-tuval", omitted: {bytes: 0}},
		});
	});

	it("keeps the settled row where the call was made, not where its answer arrived", () => {
		expect(items[1]?.kind).toBe("tool");
	});
});

describe("live streaming identities in stored history", () => {
	it("aliases thinking and reply ids without replacing stored frame identities", () => {
		const frames = loadFixture("thinking-turn") as ReadonlyArray<SDKAssistantMessage>;
		const frame = frames[0];
		expect(frame).toBeDefined();
		if (frame === undefined) return;
		const stream = loadFixture("streaming-turn") as ReadonlyArray<SDKMessage>;
		const start = stream.find(
			(message) => message.type === "stream_event" && message.event.type === "message_start",
		);
		expect(start?.type).toBe("stream_event");
		if (start?.type !== "stream_event" || start.event.type !== "message_start") return;
		// Captured reasoning body, opened by the captured stream envelope under that body's id.
		const opened = toAgentEvents(
			{
				...start,
				event: {
					...start.event,
					message: {...start.event.message, id: frame.message.id},
				},
			},
			emptyMapping,
			{at: AT},
		);
		let mapping = opened.mapping;
		const live = frames.flatMap((frame) => {
			const step = toAgentEvents(frame, mapping, {at: AT});
			mapping = step.mapping;
			return step.events.flatMap((event) => (event.kind === "item" ? [event.item] : []));
		});
		const stored: ReadonlyArray<SessionMessage> = frames.map((frame) => ({
			...frame,
			parent_agent_id: null,
		}));
		const {items, cursorAliases} = toHistoryItems(stored, {at: AT});
		expect(live.some((item) => item.kind === "thinking")).toBe(true);
		for (const item of live.filter(
			(item) => item.kind === "thinking" || item.kind === "assistant",
		)) {
			const storedId = item.kind === "thinking" ? `${frame.uuid}:thinking` : frames[1]?.uuid;
			expect(item.id).not.toBe(storedId);
			expect(cursorAliases.get(item.id)).toBe(storedId);
			expect(items.some((item) => item.id === storedId)).toBe(true);
			const page = planTranscriptPage(items, {
				before: item.id,
				cursorAliases,
				cursorBoundary: "containing-group",
				limit: 10,
			});
			expect(page.kind).toBe("page");
		}
	});
});

describe("toHistoryItems over rows it has no shape for", () => {
	it("counts a system row and never throws", () => {
		const system: unknown = {
			type: "system",
			uuid: "00000000-0000-4000-8000-000000009999",
			session_id: "s",
			message: {role: "system", content: "compacted"},
			parent_tool_use_id: null,
			parent_agent_id: null,
		};
		const {items, skipped} = toHistoryItems([system as SessionMessage], {at: AT});
		expect(items).toEqual([]);
		expect(skipped).toBe(1);
	});

	it("answers an empty session with an empty transcript", () => {
		expect(toHistoryItems([], {at: AT})).toEqual({items: [], cursorAliases: new Map(), skipped: 0});
	});
});
