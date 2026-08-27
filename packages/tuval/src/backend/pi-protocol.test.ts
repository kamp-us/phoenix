import {
	createServerMessageDecoder,
	encodeClientMessage,
	PROTOCOL_VERSION,
} from "@earendil-works/pi-protocol";
import {describe, expect, it} from "vitest";
import type {DiscoveryOutcome} from "../shared/wire.ts";
import {handlePiProtocol} from "./pi-protocol.ts";

const outcome: DiscoveryOutcome = {
	kind: "ready",
	sources: [{id: "source", label: "/tmp/.pi/agent", sessionCount: 1, skippedEntries: 0}],
	sessions: [
		{
			identity: {id: "source:session", nativeId: "session", sourceId: "source"},
			createdAt: 10,
			updatedAt: 20,
			cwd: "/workspace",
			name: "Work",
		},
	],
};

const concatenate = (...chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
	const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
};

describe("framed pi protocol", () => {
	it("accepts fragmented and coalesced CBOR frames and returns stable session metadata", async () => {
		const input = concatenate(
			encodeClientMessage({type: "hello", version: PROTOCOL_VERSION}),
			encodeClientMessage({type: "request", id: "list-1", request: {command: "list"}}),
		);
		const response = await handlePiProtocol(
			[input.subarray(0, 3), input.subarray(3, 11), input.subarray(11)],
			async () => outcome,
			{connectionId: "connection", serverId: "server"},
		);
		const decoder = createServerMessageDecoder();
		const messages = [
			...decoder.push(response.subarray(0, 5)),
			...decoder.push(response.subarray(5)),
		];
		decoder.end();
		expect(messages[0]).toMatchObject({
			type: "hello",
			connectionId: "connection",
			snapshot: {serverId: "server", sessions: [{id: "source:session"}]},
		});
		expect(messages[1]).toEqual({
			type: "response",
			id: "list-1",
			ok: true,
			result: {
				command: "list",
				sessions: [
					{
						id: "source:session",
						createdAt: 10,
						updatedAt: 20,
						cwd: "/workspace",
						sessionName: "Work",
					},
				],
			},
		});
	});

	it("rejects a stream whose first frame is not hello", async () => {
		await expect(
			handlePiProtocol(
				[encodeClientMessage({type: "request", id: "list-1", request: {command: "list"}})],
				async () => outcome,
			),
		).rejects.toThrow("requires hello");
	});
});
