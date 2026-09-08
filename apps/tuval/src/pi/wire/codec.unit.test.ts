/**
 * The seam's own proof: Tuval's messages survive a round trip through the 0.85.1 envelope, and the
 * splitter takes the session stream off the byte stream while handing every other frame on
 * unchanged.
 */

import {assert, describe, it} from "@effect/vitest";
import {
	type ClientMessage,
	createClientMessageDecoder,
	createServerFrameSplitter,
	createServerMessageDecoder,
	encodeClientMessage,
	encodeServerMessage,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	parseClientMessage,
	SESSION_SUBSCRIPTION_ID,
	type ServerMessage,
	type SessionSnapshot,
} from "./index.ts";

const SERVER_ID = "6f1c0a1e-6c2e-4a0f-9a3c-0f2c6c1a3d55";
const ATTACHMENT = "attachment-1";

const snapshot: SessionSnapshot = {
	id: "s-1",
	cwd: "/tuval/codec",
	createdAt: 0,
	updatedAt: 1,
	phase: "idle",
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
	attached: true,
	locked: true,
	revision: 3,
	transcript: [{id: "t-1", role: "user", content: [{type: "text", text: "hello"}], timestamp: 1}],
	queuedSteer: [],
	queuedSteerCount: 0,
};

const roundTripClient = (message: ClientMessage): ClientMessage => {
	const decoded = createClientMessageDecoder().push(encodeClientMessage(message));
	assert.lengthOf(decoded, 1);
	return decoded[0] as ClientMessage;
};

const roundTripServer = (message: ServerMessage): ServerMessage => {
	const decoded = createServerMessageDecoder().push(encodeServerMessage(message));
	assert.lengthOf(decoded, 1);
	return decoded[0] as ServerMessage;
};

describe("the protocol-8 wire seam", () => {
	it("negotiates version 8", () => {
		assert.strictEqual(PROTOCOL_VERSION, 8);
	});

	it("carries a session-addressed command inside the request envelope", () => {
		const message: ClientMessage = {
			type: "request",
			id: "r-1",
			target: {serverId: SERVER_ID, sessionId: snapshot.id, attachmentId: ATTACHMENT},
			request: {command: "prompt", sessionId: snapshot.id, text: "say hello"},
		};
		assert.deepStrictEqual(roundTripClient(message), message);
	});

	it("carries a cancel, which the envelope addresses but Tuval never answers", () => {
		const message: ClientMessage = {
			type: "cancel",
			id: "r-1",
			target: {serverId: SERVER_ID},
		};
		assert.deepStrictEqual(roundTripClient(message), message);
	});

	it("keeps the server hello to the server's own identity", () => {
		const hello: ServerMessage = {type: "hello", version: PROTOCOL_VERSION, serverId: SERVER_ID};
		assert.deepStrictEqual(roundTripServer(hello), hello);
	});

	it("carries a command result and a refusal under the same response envelope", () => {
		const ok: ServerMessage = {
			type: "response",
			id: "r-1",
			ok: true,
			result: {command: "attach", session: snapshot, attachmentId: ATTACHMENT},
		};
		const refused: ServerMessage = {
			type: "response",
			id: "r-2",
			ok: false,
			error: {code: "session_locked", message: "held elsewhere"},
		};
		assert.deepStrictEqual(roundTripServer(ok), ok);
		assert.deepStrictEqual(roundTripServer(refused), refused);
	});

	/** The envelope types a code as any non-empty string; Tuval names seven and folds the rest. */
	it("folds a code outside Tuval's seven onto internal_error, keeping the raw one", () => {
		// A code outside Tuval's union is exactly what a foreign peer may send, so the message is
		// built as the envelope types it and handed to the decoder as bytes.
		// biome-ignore lint/plugin: the subject under test is a code Tuval's own union forbids, which only a peer outside this app can put on the wire.
		const foreign = {
			type: "hello_error",
			error: {code: "quota_exceeded", message: "no"},
		} as unknown as ServerMessage;
		const decoded = createServerMessageDecoder().push(encodeServerMessage(foreign));
		const message = decoded[0] as ServerMessage;
		assert.strictEqual(message.type === "hello_error" ? message.error.code : "", "internal_error");
		assert.include(message.type === "hello_error" ? message.error.message : "", "quota_exceeded");
	});

	it("refuses a request whose call carries no command", () => {
		assert.throws(
			() =>
				parseClientMessage({
					type: "request",
					id: "r-1",
					target: {serverId: SERVER_ID},
					call: {serviceId: "tuval.pi", member: "list", args: []},
				}),
			ProtocolValidationError,
		);
	});
});

describe("the inbound frame splitter", () => {
	it("takes Tuval's session updates out and forwards everything else byte for byte", () => {
		const hello = encodeServerMessage({
			type: "hello",
			version: PROTOCOL_VERSION,
			serverId: SERVER_ID,
		});
		const update = encodeServerMessage({
			type: "service_update",
			subscriptionId: SESSION_SUBSCRIPTION_ID,
			update: {type: "session_snapshot", snapshot},
		});
		const response = encodeServerMessage({
			type: "response",
			id: "r-1",
			ok: true,
			result: {command: "detach", sessionId: snapshot.id},
		});

		const splitter = createServerFrameSplitter();
		const split = splitter.push(
			new Uint8Array([...hello, ...update, ...response]) as Uint8Array<ArrayBuffer>,
		);

		assert.lengthOf(split.events, 1);
		assert.deepStrictEqual(split.events[0], {type: "session_snapshot", snapshot});
		assert.deepStrictEqual(
			split.forward.map((frame) => [...frame]),
			[[...hello], [...response]],
		);
	});

	it("splits a frame arriving over two chunks", () => {
		const update = encodeServerMessage({
			type: "service_update",
			subscriptionId: SESSION_SUBSCRIPTION_ID,
			update: {type: "session_removed", sessionId: snapshot.id},
		});
		const splitter = createServerFrameSplitter();
		const head = splitter.push(update.slice(0, 6) as Uint8Array<ArrayBuffer>);
		assert.lengthOf(head.events, 0);
		const tail = splitter.push(update.slice(6) as Uint8Array<ArrayBuffer>);
		assert.deepStrictEqual(tail.events, [{type: "session_removed", sessionId: snapshot.id}]);
		assert.lengthOf(tail.forward, 0);
	});

	/** A subscription this client never opened is not Tuval's stream, so it is `Client`'s to drop. */
	it("forwards a service_update under another subscription", () => {
		const foreign = encodeServerMessage({
			type: "service_update",
			subscriptionId: "someone-else",
			update: {type: "session_removed", sessionId: snapshot.id},
		});
		const split = createServerFrameSplitter().push(foreign as Uint8Array<ArrayBuffer>);
		assert.lengthOf(split.events, 0);
		assert.deepStrictEqual(
			split.forward.map((frame) => [...frame]),
			[[...foreign]],
		);
	});
});
