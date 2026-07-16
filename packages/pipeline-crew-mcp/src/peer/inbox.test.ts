/**
 * Inbox-ack semantics (AC 2): a `Deliver` to a peer's inbox returns a `Messages.InboxAck`
 * whose meaning is delivered-to-inbox — it echoes the sender's `messageId` and is stamped
 * `by` the receiving peer. Driven over the in-memory no-serialization RPC transport
 * (`RpcTest`), so the assertion is on the real client/server delivery path, not a stub.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {RpcTest} from "effect/unstable/rpc";
import {Inbox, type InboxEnvelope, inboxHandlers, PeerInbox} from "./inbox.ts";

const envelope = (over?: Partial<InboxEnvelope>): InboxEnvelope => ({
	messageId: "msg-1",
	from: "peer-a",
	kind: "IntakePing",
	body: {issue: "3056"},
	at: "2026-07-16T10:00:00Z",
	...over,
});

const InboxB = Layer.provideMerge(inboxHandlers, Inbox.layer("peer-b"));

describe("peer/inbox", () => {
	it.effect("Deliver returns an inbox-ack (echoes messageId, acked by the receiving peer)", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(PeerInbox);
				const ack = yield* client.Deliver(envelope({messageId: "msg-42"}));
				// delivered-to-inbox: the ack correlates to the message and names its receiver.
				assert.strictEqual(ack.messageId, "msg-42");
				assert.strictEqual(ack.by, "peer-b");
			}),
		).pipe(Effect.provide(InboxB)),
	);

	it.effect("a delivered message actually lands in the receiving peer's inbox log", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(PeerInbox);
				yield* client.Deliver(envelope({messageId: "m1"}));
				yield* client.Deliver(envelope({messageId: "m2"}));
				const inbox = yield* Inbox;
				const received = yield* inbox.received;
				assert.deepStrictEqual(
					received.map((r) => r.messageId),
					["m1", "m2"],
				);
			}),
		).pipe(Effect.provide(InboxB)),
	);
});
