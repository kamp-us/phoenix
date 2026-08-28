import {
	encodeClientMessage,
	PROTOCOL_VERSION,
	ServerMessageDecoder,
	type SessionMetadata,
} from "@earendil-works/pi-protocol";
import {describe, expect, it} from "@effect/vitest";
import {Effect} from "effect";
import {listSessionsThroughProtocol, makeDiscoveryTransport} from "../src/backend/pi-protocol.js";
import {tryPromise} from "./test-effect.js";

const sessions: ReadonlyArray<SessionMetadata> = [
	{
		id: "session-one",
		createdAt: 1_777_777_777_000,
		updatedAt: 1_777_777_778_000,
		cwd: "/tmp/project",
	},
];

describe("framed pi protocol discovery", () => {
	it.effect(
		"decodes split length-prefixed CBOR frames and responds with a validated server hello",
		() =>
			Effect.gen(function* () {
				const chunks: Array<Uint8Array> = [];
				let transportError: Error | undefined;
				const factory = makeDiscoveryTransport(sessions);
				const transport = yield* tryPromise(async () =>
					factory({
						onData: (chunk) => chunks.push(chunk),
						onClose: () => {},
						onError: (error) => {
							transportError = error;
						},
					}),
				);
				const hello = encodeClientMessage({type: "hello", version: PROTOCOL_VERSION});
				yield* tryPromise(() => transport.send(hello.subarray(0, 3)));
				expect(chunks).toHaveLength(0);
				yield* tryPromise(() => transport.send(hello.subarray(3)));

				const decoder = new ServerMessageDecoder();
				const messages = chunks.flatMap((chunk) => decoder.push(chunk));
				expect(transportError).toBeUndefined();
				expect(messages).toEqual([
					expect.objectContaining({
						type: "hello",
						version: PROTOCOL_VERSION,
						snapshot: expect.objectContaining({sessions}),
					}),
				]);
				transport.close();
			}),
	);

	it.effect("enumerates through PiClient instead of bypassing its framed transport", () =>
		Effect.gen(function* () {
			expect(yield* listSessionsThroughProtocol(sessions)).toEqual(sessions);
		}),
	);
});
