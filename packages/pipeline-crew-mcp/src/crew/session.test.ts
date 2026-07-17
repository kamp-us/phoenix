/**
 * The cutover end to end (#3062): the live session's `ChannelSend`-from-peer binding stands up and
 * a crew seam round-trips over the channels protocol — proving the seams left the tmux relay.
 *
 * Driven fully in-memory (an `RpcTest` client of the real `TrackerRegistry` + an in-memory peer
 * `Connect`), the same transport-free idiom `channel-server.test.ts` uses — the one seam not
 * exercised here is the stdio `McpServer` wake, which needs a live MCP client. What IS exercised is
 * the exact `ChannelSend` the `channel_send` MCP tool routes through:
 *   - an intake ping sent through `channelSendFromPeer`'s `ChannelSend` reaches the receiver's
 *     channel edge (its recorded `ChannelSink` wake) and returns its delivered-to-inbox ack,
 *   - `inboxAddressFor` addresses every standing role distinctly (no role orphaned — the
 *     cartographer included).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Ref} from "effect";
import {RpcTest} from "effect/unstable/rpc";
import type {ChannelNotificationPayload} from "../edge/index.ts";
import {ChannelSend, ChannelSink, channelInboxLayer} from "../edge/index.ts";
import {
	type Connect,
	Dialer,
	Inbox,
	inboxHandlers,
	PeerInbox,
	PeerUnreachableError,
} from "../peer/index.ts";
import {TrackerRegistry} from "../tracker/group.ts";
import {TrackerHandlers} from "../tracker/handlers.ts";
import {RegistryLive} from "../tracker/registry.ts";
import {CREW_ROLES} from "./roles.ts";
import {channelSendFromPeer, inboxAddressFor} from "./session.ts";
import {CrewTracker, peerTrackerLayer} from "./tracker.ts";

const registryHandlers = TrackerHandlers.pipe(Layer.provide(RegistryLive));

// The sender's substrate over one shared CrewTracker: the peer Tracker port + a local inbox + the
// injected dialer — the in-memory stand-in for `peerSocketSubstrate` (session.ts).
const substrate = (
	tracker: Layer.Layer<CrewTracker>,
	address: string,
	dialer: Layer.Layer<Dialer>,
) =>
	Layer.mergeAll(
		tracker,
		peerTrackerLayer.pipe(Layer.provide(tracker)),
		Inbox.layer(address),
		dialer,
	);

describe("crew/session — cutover: the ChannelSend-from-peer binding round-trips a seam", () => {
	it.effect("an intake ping sent through ChannelSend wakes the receiver's channel edge", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const tracker = CrewTracker.fromClient(client);
			const [senderRole, receiverRole] = [CREW_ROLES[0], CREW_ROLES[1]];
			const receiverAddress = inboxAddressFor(receiverRole);

			// The receiver's channel edge: a channel-bridging inbox recording each wake, reachable as
			// an in-memory PeerInbox client. This is what a live receiver's inbox socket server hosts.
			const wakes = yield* Ref.make<ReadonlyArray<ChannelNotificationPayload>>([]);
			const recordingSink = Layer.succeed(ChannelSink, {
				wake: (payload) => Ref.update(wakes, (xs) => [...xs, payload]),
			});
			const receiverInbox = yield* RpcTest.makeClient(PeerInbox).pipe(
				Effect.provide(
					Layer.provideMerge(
						inboxHandlers,
						channelInboxLayer(receiverAddress).pipe(Layer.provide(recordingSink)),
					),
				),
			);
			const connect: Connect = (address) =>
				address === receiverAddress
					? Effect.succeed(receiverInbox)
					: Effect.fail(new PeerUnreachableError({target: address, reason: "no route"}));

			// Announce the receiver on the registry (a bare inbox here), so the sender can discover it.
			yield* client.AnnouncePresence({
				peer: receiverAddress,
				role: receiverRole,
				at: new Date().toISOString(),
			});

			// The sender's real ChannelSend-from-peer binding (the cutover) — the port channel_send uses.
			const ack = yield* Effect.gen(function* () {
				const sender = yield* ChannelSend;
				return yield* sender.send(receiverRole, "IntakePing", {issue: "3062", from: senderRole});
			}).pipe(
				Effect.provide(
					channelSendFromPeer(senderRole).pipe(
						Layer.provide(
							substrate(tracker, inboxAddressFor(senderRole), Dialer.layerFromConnect(connect)),
						),
					),
				),
			);

			// Delivered straight to the receiver's inbox (peer→peer, the tracker never relays).
			assert.strictEqual(ack.by, receiverAddress, "acked by the receiver's inbox ⇒ it went to it");
			const recorded = yield* Ref.get(wakes);
			assert.lengthOf(recorded, 1);
			assert.match(recorded[0]?.message ?? "", /IntakePing/, "the seam rode a channel wake");
			assert.strictEqual(recorded[0]?._meta?.from, inboxAddressFor(senderRole));
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect("a send to an offline role surfaces as a typed unreachable, never a silent drop", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const tracker = CrewTracker.fromClient(client);
			const [senderRole, offlineRole] = [CREW_ROLES[0], CREW_ROLES[2]];
			const alwaysUnreachable = Dialer.layerFromConnect((address) =>
				Effect.fail(new PeerUnreachableError({target: address, reason: "no route"})),
			);

			const failure = yield* Effect.gen(function* () {
				const sender = yield* ChannelSend;
				return yield* sender.send(offlineRole, "IntakePing", {});
			}).pipe(
				Effect.provide(
					channelSendFromPeer(senderRole).pipe(
						Layer.provide(substrate(tracker, inboxAddressFor(senderRole), alwaysUnreachable)),
					),
				),
				Effect.flip,
			);
			assert.instanceOf(failure, PeerUnreachableError);
			assert.strictEqual(failure.target, offlineRole);
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);
});

describe("crew/session — the roster is intact (no role orphaned)", () => {
	it("inboxAddressFor addresses every standing role distinctly", () => {
		const addresses = CREW_ROLES.map(inboxAddressFor);
		assert.lengthOf(
			addresses,
			CREW_ROLES.length,
			"every standing role gets an inbox address (the cartographer included)",
		);
		assert.strictEqual(
			new Set(addresses).size,
			CREW_ROLES.length,
			"every role maps to a distinct inbox address",
		);
		assert.include(addresses, "inbox://cartographer", "the cartographer must have an address");
	});
});
