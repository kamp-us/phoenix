/**
 * The composition root end to end (ACs 2 + 3), driven fully in-memory: an `RpcTest` client of
 * the real `TrackerRegistry` (backed by `RegistryLive`) IS the crew tracker, so every announce /
 * discover / claim / role-lease runs through the real registry semantics — no socket opened.
 *
 *   - AC 2: two roles stand up (tracker + peer + edge composed), announce, discover each other,
 *     and exchange a claim/collision-check with a typed reply; a peer-to-peer intake ping wakes
 *     the receiver's edge channel sink and returns its inbox-ack (peer + edge in the loop).
 *   - AC 3: the role-uniqueness lease rejects a second live session for a held role, across all
 *     five standing roles.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Option, Ref} from "effect";
import {RpcTest} from "effect/unstable/rpc";
import {ChannelSink, channelInboxLayer} from "../edge/index.ts";
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
import {makeCrewChannel} from "./channel-server.ts";
import {RoleUniquenessError} from "./errors.ts";
import {CREW_ROLES} from "./roles.ts";
import {CrewTracker, peerTrackerLayer} from "./tracker.ts";

const registryHandlers = TrackerHandlers.pipe(Layer.provide(RegistryLive));

// A dialer that always fails — used where the peer-to-peer send is not the thing under test.
const alwaysUnreachable = Dialer.layerFromConnect((address) =>
	Effect.fail(new PeerUnreachableError({target: address, reason: "no route"})),
);

// The per-channel substrate over a shared CrewTracker: the peer Tracker port + a local inbox +
// a dialer. Sharing the tracker layer keeps every channel on ONE registry (so they discover
// each other); the inbox/dialer vary per channel identity.
const channelLayers = (
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

describe("crew/channel-server — announce, discover, claim/collision-check (AC 2)", () => {
	it.effect("two roles announce, discover each other, and exchange a typed claim reply", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const tracker = CrewTracker.fromClient(client);
			const [roleA, roleB] = [CREW_ROLES[0], CREW_ROLES[1]];

			const a = yield* makeCrewChannel({role: roleA, address: "inbox://a"}).pipe(
				Effect.provide(channelLayers(tracker, "inbox://a", alwaysUnreachable)),
			);
			const b = yield* makeCrewChannel({role: roleB, address: "inbox://b"}).pipe(
				Effect.provide(channelLayers(tracker, "inbox://b", alwaysUnreachable)),
			);

			// discover each other across the flat topology
			const aFindsB = yield* a.discover(roleB);
			const bFindsA = yield* b.discover(roleA);
			assert.isTrue(Option.isSome(aFindsB));
			assert.strictEqual(Option.getOrThrow(aFindsB).address, "inbox://b");
			assert.isTrue(Option.isSome(bFindsA));
			assert.strictEqual(Option.getOrThrow(bFindsA).address, "inbox://a");

			// a synchronous claim/collision-check with a typed reply: A grants, B collides
			const granted = yield* a.claim("issue-3059");
			assert.isTrue(granted.granted);
			assert.isFalse(granted.collision);
			assert.strictEqual(granted.owner, "inbox://a");

			const collided = yield* b.claim("issue-3059");
			assert.isFalse(collided.granted);
			assert.isTrue(collided.collision);
			assert.strictEqual(collided.owner, "inbox://a", "the incumbent keeps the resource");
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect("an intake ping reaches the receiver's edge channel + returns its inbox-ack", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const tracker = CrewTracker.fromClient(client);
			const [roleA, roleB] = [CREW_ROLES[0], CREW_ROLES[1]];

			// The receiver's edge: a channel-bridging inbox whose ChannelSink records each wake,
			// proving the peer→edge last-mile fires. Reachable as an in-memory PeerInbox client.
			const wakes = yield* Ref.make<ReadonlyArray<unknown>>([]);
			const recordingSink = Layer.succeed(ChannelSink, {
				wake: (payload) => Ref.update(wakes, (xs) => [...xs, payload]),
			});
			const bInbox = yield* RpcTest.makeClient(PeerInbox).pipe(
				Effect.provide(
					Layer.provideMerge(
						inboxHandlers,
						channelInboxLayer("inbox://b").pipe(Layer.provide(recordingSink)),
					),
				),
			);
			const connect: Connect = (address) =>
				address === "inbox://b"
					? Effect.succeed(bInbox)
					: Effect.fail(new PeerUnreachableError({target: address, reason: "no route"}));

			// announce B directly on the registry (it is a bare inbox here, not a full channel),
			// then stand up A as a full channel that dials B.
			yield* client.AnnouncePresence({
				peer: "inbox://b",
				role: roleB,
				at: new Date().toISOString(),
			});
			const a = yield* makeCrewChannel({role: roleA, address: "inbox://a"}).pipe(
				Effect.provide(channelLayers(tracker, "inbox://a", Dialer.layerFromConnect(connect))),
			);

			const ack = yield* a.peer.send(roleB, "IntakePing", {issue: "3059", from: roleA});
			assert.strictEqual(ack.by, "inbox://b", "acked by B's inbox ⇒ it went straight to B");
			const recorded = yield* Ref.get(wakes);
			assert.lengthOf(recorded, 1);
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);
});

describe("crew/channel-server — role-uniqueness lease (AC 3)", () => {
	it.effect("a second live session for a held role is rejected, across all five roles", () =>
		Effect.gen(function* () {
			for (const role of CREW_ROLES) {
				const client = yield* RpcTest.makeClient(TrackerRegistry);
				const tracker = CrewTracker.fromClient(client);

				// first session for the role acquires the lease
				const first = yield* makeCrewChannel({role, address: `inbox://${role}-1`}).pipe(
					Effect.provide(channelLayers(tracker, `inbox://${role}-1`, alwaysUnreachable)),
				);
				assert.strictEqual(first.role, role);

				// a second session (a DIFFERENT peer) for the same held role is rejected, not shared
				const rejection = yield* makeCrewChannel({role, address: `inbox://${role}-2`}).pipe(
					Effect.provide(channelLayers(tracker, `inbox://${role}-2`, alwaysUnreachable)),
					Effect.flip,
				);
				assert.instanceOf(rejection, RoleUniquenessError);
				assert.strictEqual(rejection.role, role);
				assert.strictEqual(rejection.heldBy, `inbox://${role}-1`);
			}
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect(
		"all five distinct roles hold their leases simultaneously (uniqueness is per role)",
		() =>
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(TrackerRegistry);
				const tracker = CrewTracker.fromClient(client);
				for (const role of CREW_ROLES) {
					const channel = yield* makeCrewChannel({role, address: `inbox://${role}`}).pipe(
						Effect.provide(channelLayers(tracker, `inbox://${role}`, alwaysUnreachable)),
					);
					assert.strictEqual(channel.role, role);
				}
				// every role is independently discoverable — five distinct leases coexist
				for (const role of CREW_ROLES) {
					const result = yield* client.LookupRole({role});
					assert.lengthOf(result.peers, 1, `${role} should be present`);
				}
			}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);
});
