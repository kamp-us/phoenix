import {encodeServerMessage, PROTOCOL_VERSION} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "@effect/vitest";
import {projectModelCost} from "./cost.ts";
import {scriptedModel} from "./fixtures.ts";
import {projectTranscript, projectUsage, type SourceMessage} from "./transcript.ts";

const serverSnapshotCarrying = (cost: unknown) => ({
	type: "hello" as const,
	version: PROTOCOL_VERSION,
	connectionId: "c1",
	snapshot: {
		serverId: "s1",
		protocolVersion: PROTOCOL_VERSION,
		revision: 0,
		sessions: [],
		models: [{...scriptedModel, cost}],
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

	it("is what keeps a tiered cost encodable — the unprojected one is refused", () => {
		const tiered = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			tiers: [{inputTokensAbove: 200_000, input: 9, output: 9, cacheRead: 9, cacheWrite: 9}],
		};
		assert.throws(() => encodeServerMessage(serverSnapshotCarrying(tiered) as never));
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
			type: "event",
			event: {
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
