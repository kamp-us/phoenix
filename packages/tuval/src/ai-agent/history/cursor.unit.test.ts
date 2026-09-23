/**
 * Which held row a page cursor may be minted from — the whole of what stands between a load-more
 * and the unknown-cursor banner (#8814).
 *
 * A backend's history read resolves the conversation's own turns and nothing else, so a cursor
 * naming a session notice or a nested worker's row comes back `cursor-not-found`. Both classes are
 * live-only by construction: the Claude CLI writes a worker's frames to a `subagents/agent-*.jsonl`
 * sidecar, and a task notice is minted from an SDK notification that was never a message.
 */

import {describe, expect, it} from "vitest";
import {
	assistantItem,
	nestedUnder,
	systemItem,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import {pageCursor} from "./cursor.ts";

describe("the rows a page cursor may be minted from", () => {
	it("leaves an ordinary stored row as its own cursor", () => {
		const held = [userItem("prompt"), assistantItem("reply")];
		expect(pageCursor(held, "prompt")).toEqual({kind: "page", before: "prompt"});
	});

	it("walks off a task notice to the oldest row a stored session can resolve", () => {
		const held = [systemItem("task-notice"), assistantItem("reply"), userItem("prompt")];
		expect(pageCursor(held, "task-notice")).toEqual({kind: "page", before: "reply"});
	});

	it("walks off a nested worker's row the same way", () => {
		const held = [
			nestedUnder(assistantItem("worker-reply"), "spawn"),
			nestedUnder(toolItem("worker-tool"), "spawn"),
			assistantItem("reply"),
		];
		expect(pageCursor(held, "worker-reply")).toEqual({kind: "page", before: "reply"});
	});

	it("refuses rather than mint one when every row past the anchor is unavailable", () => {
		const held = [
			systemItem("task-started"),
			nestedUnder(toolItem("worker-tool"), "spawn"),
			systemItem("task-progress"),
		];
		expect(pageCursor(held, "task-started")).toEqual({kind: "unavailable"});
	});
});
