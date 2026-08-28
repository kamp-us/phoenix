import {strict as assert} from "node:assert";
import {describe, it} from "@effect/vitest";
import {decodeLiveEvent} from "../../src/frontend-shell/fate-client.js";

const sessionEvent = (toolCall: Readonly<Record<string, unknown>>): unknown => ({
	_tag: "session",
	sequence: 5,
	session: {
		_tag: "attached",
		sessionId: "alpha",
		revision: 2,
		phase: "turn",
		model: {provider: "anthropic", id: "claude-sonnet"},
		thinkingLevel: "high",
		completion: "running",
		transcript: [
			{
				id: "tool-1",
				role: "assistant",
				content: [toolCall],
				timestamp: 1,
				status: "running",
			},
		],
		lastEventSequence: 5,
		connection: "connected",
		ownership: "exclusive",
	},
});

describe("Tuval live event decoder", () => {
	it("rejects a tool call whose required input field is absent", () => {
		assert.equal(
			decodeLiveEvent(sessionEvent({type: "toolCall", toolCallId: "call-1", toolName: "read"})),
			undefined,
		);
	});

	it("accepts a tool call with an explicitly present unknown input", () => {
		assert.notEqual(
			decodeLiveEvent(
				sessionEvent({
					type: "toolCall",
					toolCallId: "call-1",
					toolName: "read",
					input: null,
				}),
			),
			undefined,
		);
	});
});
