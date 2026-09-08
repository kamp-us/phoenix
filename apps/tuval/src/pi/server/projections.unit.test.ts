import {assert, describe, it} from "@effect/vitest";
import {encodeServerMessage, PROTOCOL_VERSION, SESSION_SUBSCRIPTION_ID} from "../wire/index.ts";
import {streamingMessage} from "./AgentSessionHost.ts";
import {projectModelCost} from "./cost.ts";
import {scriptedModel} from "./fixtures.ts";
import {projectTranscript, projectUsage, type SourceMessage} from "./transcript.ts";

const serverSnapshotCarrying = (cost: unknown) => ({
	type: "service_update" as const,
	subscriptionId: SESSION_SUBSCRIPTION_ID,
	update: {
		type: "server_snapshot" as const,
		snapshot: {
			serverId: "6f1c0a1e-6c2e-4a0f-9a3c-0f2c6c1a3d55",
			protocolVersion: PROTOCOL_VERSION,
			revision: 0,
			sessions: [],
			models: [{...scriptedModel, cost}],
		},
	},
});

describe("projectModelCost", () => {
	it("keeps the four protocol fields", () => {
		assert.deepStrictEqual(
			projectModelCost({
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				tiers: [{inputTokensAbove: 200_000, input: 9, output: 9, cacheRead: 9, cacheWrite: 9}],
			}),
			{input: 1, output: 2, cacheRead: 3, cacheWrite: 4},
		);
	});

	/**
	 * Protocol 8 carries every payload opaque, so the envelope no longer refuses an unprojected
	 * cost the way the 0.84.3 `ModelCostSchema` did — the projection is now the only thing keeping
	 * a tiered cost off the wire, which is exactly why it is asserted rather than assumed.
	 */
	it("is what keeps a tiered cost off the wire, now that the envelope does not judge it", () => {
		const tiered = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			tiers: [{inputTokensAbove: 200_000, input: 9, output: 9, cacheRead: 9, cacheWrite: 9}],
		};
		assert.notProperty(projectModelCost(tiered), "tiers");
		encodeServerMessage(serverSnapshotCarrying(projectModelCost(tiered)) as never);
	});
});

describe("projectUsage", () => {
	it("drops the fields the wire's strict usage does not declare", () => {
		assert.deepStrictEqual(
			projectUsage({
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 2,
				totalTokens: 17,
				cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
			} as never),
			{
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 2,
				totalTokens: 17,
				cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
			},
		);
	});
});

describe("projectTranscript", () => {
	const messages: ReadonlyArray<SourceMessage> = [
		{role: "user", content: "read the file", timestamp: 1},
		{
			role: "assistant",
			content: [
				{type: "text", text: "on it"},
				{type: "toolCall", id: "call-1", name: "read", arguments: {path: "a.txt"}},
			],
			provider: "faux",
			model: "faux-1",
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{type: "text", text: "hello"}],
			isError: false,
			timestamp: 3,
		},
	];

	it("maps user, assistant and tool messages onto the wire's item union", () => {
		const items = projectTranscript(messages);
		assert.deepStrictEqual(
			items.map((item) => [item.id, item.role]),
			[
				["item-0", "user"],
				["item-1", "assistant"],
				["item-2", "tool"],
			],
		);
	});

	it("reads a tool result's input back off the call that made it", () => {
		const tool = projectTranscript(messages)[2];
		assert.deepStrictEqual(tool, {
			id: "item-2",
			role: "tool",
			toolCallId: "call-1",
			toolName: "read",
			input: {path: "a.txt"},
			content: [{type: "text", text: "hello"}],
			timestamp: 3,
			status: "complete",
			isError: false,
		});
	});

	it("produces items the wire accepts", () => {
		encodeServerMessage({
			type: "service_update",
			subscriptionId: SESSION_SUBSCRIPTION_ID,
			update: {
				type: "session_snapshot",
				snapshot: {
					id: "s",
					cwd: "/tmp",
					createdAt: 0,
					updatedAt: 0,
					phase: "idle",
					model: {provider: "faux", id: "faux-1"},
					thinkingLevel: "off",
					attached: true,
					locked: true,
					revision: 1,
					transcript: [...projectTranscript(messages)],
					queuedSteer: [],
					queuedSteerCount: 0,
				},
			},
		});
	});
});

describe("projectTranscript over a reply still being written", () => {
	const asked: SourceMessage = {role: "user", content: "say hello", timestamp: 1};

	const growing = (text: string): SourceMessage => ({
		role: "assistant",
		content: [{type: "text", text}],
		provider: "faux",
		model: "faux-1",
		stopReason: "pending",
		timestamp: 2,
	});

	const landed: SourceMessage = {
		role: "assistant",
		content: [{type: "text", text: "hello there"}],
		provider: "faux",
		model: "faux-1",
		stopReason: "stop",
		timestamp: 2,
	};

	it("projects it as the last item, marked streaming", () => {
		const items = projectTranscript([asked], growing("hel"));
		assert.deepStrictEqual(
			items.map((item) => [item.id, item.role]),
			[
				["item-0", "user"],
				["item-1", "assistant"],
			],
		);
		assert.deepStrictEqual(items[1], {
			id: "item-1",
			role: "assistant",
			content: [{type: "text", text: "hel"}],
			model: {provider: "faux", id: "faux-1"},
			timestamp: 2,
			status: "streaming",
		});
	});

	it("gives it the id the finished message lands under, so a snapshot supersedes one item", () => {
		const ids = (items: ReadonlyArray<{readonly id: string}>) => items.map((item) => item.id);
		const first = projectTranscript([asked], growing("hel"));
		const second = projectTranscript([asked], growing("hello th"));
		const final = projectTranscript([asked, landed]);

		assert.deepStrictEqual(ids(first), ids(second));
		assert.deepStrictEqual(ids(second), ids(final));
		assert.strictEqual(final[1]?.id, "item-1");
	});

	/**
	 * The turn #8390 recorded: an adapter that settles `stopReason` before the stream ends. The
	 * OpenAI-Responses one assigns `"stop"` at a `message` item's `final_answer` phase and keeps
	 * pushing deltas onto the same object, and Pi's own loop stops an assistant message on
	 * `"toolUse"` and then opens another. Every revision here is one the host published while
	 * `AgentState.streamingMessage` was still set, so every one of them has to be marked.
	 */
	it("marks every revision it is handed as in flight, whatever the stop reason says", () => {
		const settling = (text: string, stopReason: string): SourceMessage => ({
			role: "assistant",
			content: [{type: "text", text}],
			provider: "faux",
			model: "faux-1",
			stopReason,
			timestamp: 2,
		});
		const toolCall: SourceMessage = {
			role: "assistant",
			content: [{type: "toolCall", id: "call-1", name: "read_file", arguments: {path: "a.md"}}],
			provider: "faux",
			model: "faux-1",
			stopReason: "toolUse",
			timestamp: 2,
		};
		const toolResult: SourceMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read_file",
			content: [{type: "text", text: "the file"}],
			isError: false,
			timestamp: 3,
		};

		const midTurn: ReadonlyArray<readonly [ReadonlyArray<SourceMessage>, SourceMessage]> = [
			[[asked], growing("hel")],
			[[asked], settling("hello there", "stop")],
			[[asked], settling("hello there, reading", "toolUse")],
			[[asked, toolCall, toolResult], growing("the file")],
			[[asked, toolCall, toolResult], settling("the file says hi", "stop")],
		];

		for (const [messages, streaming] of midTurn) {
			const items = projectTranscript(messages, streaming);
			const last = items.at(-1);
			assert.deepInclude(
				last,
				{role: "assistant", status: "streaming"},
				`a revision published mid-turn read as settled: ${JSON.stringify(last)}`,
			);
			assert.notProperty(last, "stopReason");
		}

		// The same message once `message_end` clears `streamingMessage`: settled, and no longer
		// keyed as in flight, so its own stop reason is what speaks.
		assert.deepInclude(projectTranscript([asked, landed]).at(-1), {
			status: "complete",
			stopReason: "stop",
		});
	});

	it("leaves the transcript untouched when nothing is in flight", () => {
		assert.deepStrictEqual(projectTranscript([asked, landed], undefined), [
			...projectTranscript([asked, landed]),
		]);
	});

	it("produces a streaming item the wire accepts", () => {
		encodeServerMessage({
			type: "service_update",
			subscriptionId: SESSION_SUBSCRIPTION_ID,
			update: {
				type: "session_snapshot",
				snapshot: {
					id: "s",
					cwd: "/tmp",
					createdAt: 0,
					updatedAt: 0,
					phase: "turn",
					model: {provider: "faux", id: "faux-1"},
					thinkingLevel: "off",
					attached: true,
					locked: true,
					revision: 1,
					transcript: [...projectTranscript([asked], growing("hel"))],
					queuedSteer: [],
					queuedSteerCount: 0,
				},
			},
		});
	});
});

describe("streamingMessage", () => {
	const inFlight: SourceMessage = {
		role: "assistant",
		content: [{type: "text", text: "hel"}],
		provider: "faux",
		model: "faux-1",
		stopReason: "pending",
		timestamp: 0,
	};

	it("is nothing unless a caller asked for it", () => {
		assert.strictEqual(streamingMessage({}, {streamingMessage: inFlight}), undefined);
		assert.strictEqual(
			streamingMessage({streamPartialText: false}, {streamingMessage: inFlight}),
			undefined,
		);
	});

	it("leaves the projected transcript the settled messages alone when it is off", () => {
		const asked: SourceMessage = {
			role: "user",
			content: [{type: "text", text: "say hello"}],
			timestamp: 1,
		};
		const items = projectTranscript(
			[asked, {...inFlight, content: [{type: "text", text: "hello there"}], stopReason: "stop"}],
			streamingMessage({}, {streamingMessage: inFlight}),
		);
		assert.deepStrictEqual(
			items.map((item) => item.id),
			["item-0", "item-1"],
		);
		assert.isFalse(items.some((item) => "status" in item && item.status === "streaming"));
	});

	it("is the in-flight message when the flag is on", () => {
		assert.strictEqual(
			streamingMessage({streamPartialText: true}, {streamingMessage: inFlight}),
			inFlight,
		);
		assert.strictEqual(streamingMessage({streamPartialText: true}, {}), undefined);
	});
});
