import {describe, expect, it} from "vitest";
import {isTranscriptItem} from "../ai-agent/ports/index.ts";
import {historyItem, LiveTranscript} from "./history.ts";

const command = {
	type: "commandExecution",
	id: "shell",
	command: "ls",
	cwd: "/tmp",
	status: "inProgress",
	aggregatedOutput: "",
};

describe("Codex transcript mapping", () => {
	it("bounds tool results and preserves UTF-8", () => {
		const item = historyItem(
			{...command, status: "completed", aggregatedOutput: "🦊".repeat(3000)},
			1000,
		);
		expect(isTranscriptItem(item)).toBe(true);
		expect(item).toMatchObject({
			kind: "tool",
			status: "ok",
			result: {text: "🦊".repeat(2000), omitted: {bytes: 4000}},
		});
	});
	it("keeps final replies on the partial item's id and timestamp", () => {
		const mapping = new LiveTranscript();
		mapping.item({type: "agentMessage", id: "a", text: ""}, 1000, true);
		expect(mapping.delta("a", "hello")).toMatchObject({
			id: "a",
			timestamp: 1000,
			text: "hello",
			partial: true,
		});
		const final = mapping.item({type: "agentMessage", id: "a", text: "hello"}, 2000, false);
		expect(final.timestamp).toBe(1000);
		expect(final).not.toHaveProperty("partial");
	});
	it("settles interrupted replies and unfinished tool rows", () => {
		const mapping = new LiveTranscript();
		mapping.item({type: "agentMessage", id: "a", text: "partial"}, 1000, true);
		mapping.item(command, 1000, false);
		expect(mapping.finish(true)).toMatchObject([
			{id: "a", interrupted: true},
			{id: "shell", status: "error"},
		]);
		expect(mapping.items.size).toBe(0);
	});
	it("keeps reasoning, compaction and unknown items visible without leaking invalid values", () => {
		expect(
			historyItem({type: "reasoning", id: "r", summary: ["summary"], content: ["detail"]}, 1),
		).toMatchObject({kind: "thinking", text: "summary"});
		expect(historyItem({type: "contextCompaction", id: "c"}, 1)).toMatchObject({
			kind: "compaction",
		});
		expect(historyItem({type: "futureEvent", id: "f", detail: "x".repeat(9000)}, 1)).toMatchObject({
			kind: "system",
			text: "Codex: futureEvent",
		});
		expect(() => historyItem({type: "agentMessage", id: "a", text: 42}, 1)).toThrow();
	});
});
