import {
	encodeClientMessage,
	PROTOCOL_VERSION,
	ServerMessageDecoder,
	type SessionMetadata,
} from "@earendil-works/pi-protocol";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {listSessionsThroughProtocol, makeDiscoveryTransport} from "../src/backend/pi-protocol.js";

const sessions: ReadonlyArray<SessionMetadata> = [
	{
		id: "session-one",
		createdAt: 1_777_777_777_000,
		updatedAt: 1_777_777_778_000,
		cwd: "/tmp/project",
	},
];

describe("framed pi protocol discovery", () => {
	it("decodes split length-prefixed CBOR frames and responds with a validated server hello", async () => {
		const chunks: Array<Uint8Array> = [];
		const factory = makeDiscoveryTransport(sessions);
		const transport = await factory({
			onData: (chunk) => chunks.push(chunk),
			onClose: () => {},
			onError: (error) => {
				throw error;
			},
		});
		const hello = encodeClientMessage({type: "hello", version: PROTOCOL_VERSION});
		await transport.send(hello.subarray(0, 3));
		expect(chunks).toHaveLength(0);
		await transport.send(hello.subarray(3));

		const decoder = new ServerMessageDecoder();
		const messages = chunks.flatMap((chunk) => decoder.push(chunk));
		expect(messages).toEqual([
			expect.objectContaining({
				type: "hello",
				version: PROTOCOL_VERSION,
				snapshot: expect.objectContaining({sessions}),
			}),
		]);
		transport.close();
	});

	it("enumerates through PiClient instead of bypassing its framed transport", async () => {
		await expect(Effect.runPromise(listSessionsThroughProtocol(sessions))).resolves.toEqual(
			sessions,
		);
	});
});
