/**
 * Driven by `fixtures/session-messages.json` — the rows `getSessionMessages` actually returned for
 * the same session `fixtures/tool-turn.json` was streamed from, so the two fixtures are one
 * conversation read through both wire forms.
 */

import type {SessionMessage} from "@anthropic-ai/claude-agent-sdk";
import {describe, expect, it} from "vitest";
import {loadFixture} from "./fixtures/load.ts";
import {toHistoryItems} from "./items.ts";

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
		expect(toHistoryItems([], {at: AT})).toEqual({items: [], skipped: 0});
	});
});
