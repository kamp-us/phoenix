import {strict as assert} from "node:assert";
import {describe, it} from "@effect/vitest";
import {
	bindAttachOutcome,
	bindPromptOutcome,
	decodeLineageProjection,
	decodeLiveEvent,
} from "../../src/frontend-shell/fate-client.js";
import type {AttachedLiveSession} from "../../src/shared/live-session.js";

const attachedSession = (sessionId: string): AttachedLiveSession => ({
	_tag: "attached",
	sessionId,
	revision: 2,
	phase: "idle",
	model: {provider: "anthropic", id: "claude-sonnet"},
	thinkingLevel: "high",
	completion: "idle",
	transcript: [],
	lastEventSequence: 5,
	connection: "connected",
	ownership: "exclusive",
});

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

describe("Tuval lineage decoder", () => {
	it("consumes the shared typed projection and refuses malformed graph arms", () => {
		const projection = {
			graph: {
				version: 2,
				nodes: [
					{
						id: "pi:root",
						piSessionId: "root",
						createdAt: 1,
						updatedAt: 2,
						cwd: "/work/root",
						sourceFiles: ["/fixtures/root.jsonl"],
					},
				],
				edges: [],
				continuity: [],
				ownership: [],
			},
			problems: [],
		};
		assert.notEqual(decodeLineageProjection(projection), undefined);
		assert.equal(
			decodeLineageProjection({...projection, graph: {...projection.graph, version: 3}}),
			undefined,
		);
	});
});

describe("Tuval fate request identity", () => {
	it("turns a valid attach response for another session into a protocol refusal", () => {
		const outcome = bindAttachOutcome("alpha", {
			_tag: "attached",
			session: attachedSession("beta"),
		});

		assert.equal(outcome._tag, "refused");
		if (outcome._tag === "refused") {
			assert.equal(outcome.sessionId, "alpha");
			assert.equal(outcome.code, "protocol");
		}
	});

	it("turns a prompt response with another correlation into a protocol refusal", () => {
		const outcome = bindPromptOutcome("alpha", "request-1", {
			_tag: "acknowledged",
			correlationId: "request-2",
			session: attachedSession("alpha"),
		});

		assert.equal(outcome._tag, "refused");
		assert.equal(outcome.correlationId, "request-1");
		if (outcome._tag === "refused") assert.equal(outcome.code, "protocol");
	});

	it("turns a prompt acknowledgement for another session into a protocol refusal", () => {
		const outcome = bindPromptOutcome("alpha", "request-1", {
			_tag: "acknowledged",
			correlationId: "request-1",
			session: attachedSession("beta"),
		});

		assert.equal(outcome._tag, "refused");
		assert.equal(outcome.correlationId, "request-1");
		if (outcome._tag === "refused") assert.equal(outcome.code, "protocol");
	});
});
