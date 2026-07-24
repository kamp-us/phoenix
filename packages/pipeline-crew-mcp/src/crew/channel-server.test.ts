/**
 * The composition root end to end (ACs 2 + 3), driven fully in-memory: an `RpcTest` client of
 * the real `TrackerRegistry` (backed by `RegistryLive`) IS the crew tracker, so every announce /
 * discover / claim / role-lease runs through the real registry semantics — no socket opened.
 *
 *   - AC 2: two roles stand up (tracker + peer + edge composed), announce, discover each other,
 *     and exchange a claim/collision-check with a typed reply; a peer-to-peer intake ping wakes
 *     the receiver's edge channel sink and returns its inbox-ack (peer + edge in the loop).
 *   - AC 3: the per-kind cardinality lease — a second live session for a BRIDGE role is rejected
 *     (cardinality 1), a second live session for an ENGINE role is admitted (cardinality N).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Ref} from "effect";
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
import {inboxSocketPathFor, makeCrewChannel} from "./channel-server.ts";
import {RoleUniquenessError} from "./errors.ts";
import {CREW_ROLES, kindOf} from "./roles.ts";
import {CrewTracker, peerTrackerLayer} from "./tracker.ts";

const BRIDGE_ROLES = CREW_ROLES.filter((role) => kindOf(role) === "bridge");
const ENGINE_ROLES = CREW_ROLES.filter((role) => kindOf(role) === "engine");

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
			// presence is announced explicitly now (the peer no longer announces on construction, #3628):
			// each channel publishes its presence — standing in for "its inbox is attached and serving".
			yield* a.announce;
			yield* b.announce;

			// discover each other across the flat topology (each a singleton set here)
			const aFindsB = yield* a.discover(roleB);
			const bFindsA = yield* b.discover(roleA);
			assert.lengthOf(aFindsB, 1);
			assert.strictEqual(aFindsB[0]?.address, "inbox://b");
			assert.lengthOf(bFindsA, 1);
			assert.strictEqual(bFindsA[0]?.address, "inbox://a");

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

	it.effect(
		"a channel can release its own claim, freeing the resource for another (#3796 facet 2)",
		() =>
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

				// A claims, so B collides while A holds it
				assert.isTrue((yield* a.claim("issue-3059")).granted);
				assert.isTrue((yield* b.claim("issue-3059")).collision, "B blocked while A holds it");

				// A releases through the channel — the release verb is now reachable at the channel edge
				yield* a.release("issue-3059");

				// B can now claim the freed resource
				const bAfter = yield* b.claim("issue-3059");
				assert.isTrue(bAfter.granted, "the released resource is claimable by the next channel");
				assert.strictEqual(bAfter.owner, "inbox://b");
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

			const ack = yield* a.peer.send(roleB, "IntakePing", {issue: 3059, from: roleA});
			assert.strictEqual(ack.by, "inbox://b", "acked by B's inbox ⇒ it went straight to B");
			const recorded = yield* Ref.get(wakes);
			assert.lengthOf(recorded, 1);
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);
});

describe("crew/channel-server — per-kind cardinality lease (AC 3)", () => {
	it.effect("a second live session for a BRIDGE role is rejected (cardinality 1)", () =>
		Effect.gen(function* () {
			assert.isAbove(BRIDGE_ROLES.length, 0, "the roster must carry at least one bridge role");
			for (const role of BRIDGE_ROLES) {
				const client = yield* RpcTest.makeClient(TrackerRegistry);
				const tracker = CrewTracker.fromClient(client);

				// first session for the bridge role acquires the singleton lease
				const first = yield* makeCrewChannel({role, address: `inbox://${role}-1`}).pipe(
					Effect.provide(channelLayers(tracker, `inbox://${role}-1`, alwaysUnreachable)),
				);
				assert.strictEqual(first.role, role);

				// a second session (a DIFFERENT peer) for the same held bridge role is rejected, not shared
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

	it.effect("a second live session for an ENGINE role boots cleanly (cardinality N)", () =>
		Effect.gen(function* () {
			assert.isAbove(ENGINE_ROLES.length, 0, "the roster must carry at least one engine role");
			for (const role of ENGINE_ROLES) {
				const client = yield* RpcTest.makeClient(TrackerRegistry);
				const tracker = CrewTracker.fromClient(client);

				// two DIFFERENT-peer sessions for the same engine role both stand up — the per-instance
				// lease key never collapses onto the single-role key, so neither rejects the other
				const first = yield* makeCrewChannel({role, address: `inbox://${role}-1`}).pipe(
					Effect.provide(channelLayers(tracker, `inbox://${role}-1`, alwaysUnreachable)),
				);
				const second = yield* makeCrewChannel({role, address: `inbox://${role}-2`}).pipe(
					Effect.provide(channelLayers(tracker, `inbox://${role}-2`, alwaysUnreachable)),
				);
				assert.strictEqual(first.role, role);
				assert.strictEqual(second.role, role);
				assert.notStrictEqual(first.address, second.address, "two distinct engine instances");

				// both hold a live per-instance lease: a fresh third instance still boots (N unbounded)
				const third = yield* makeCrewChannel({role, address: `inbox://${role}-3`}).pipe(
					Effect.provide(channelLayers(tracker, `inbox://${role}-3`, alwaysUnreachable)),
				);
				assert.strictEqual(third.role, role);
			}
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect(
		"connection-is-lease per kind: a freed bridge lease lets a replacement bridge boot",
		() =>
			Effect.gen(function* () {
				const role = BRIDGE_ROLES[0];
				assert(role !== undefined, "the roster must carry a bridge role");
				const client = yield* RpcTest.makeClient(TrackerRegistry);
				const tracker = CrewTracker.fromClient(client);

				// a bridge boots, holding the singleton lease on the bare role key
				const incumbent = yield* makeCrewChannel({role, address: `inbox://${role}-a`}).pipe(
					Effect.provide(channelLayers(tracker, `inbox://${role}-a`, alwaysUnreachable)),
				);
				assert.strictEqual(incumbent.role, role);

				// the connection closes → its lease frees (the singleton key is released); a second
				// bridge before the release would collide, but a release makes the key acquirable again
				yield* client.Release({
					resource: role,
					claimant: `inbox://${role}-a`,
					at: new Date().toISOString(),
				});

				// a replacement bridge (a fresh peer) boots cleanly onto the freed singleton lease
				const replacement = yield* makeCrewChannel({role, address: `inbox://${role}-b`}).pipe(
					Effect.provide(channelLayers(tracker, `inbox://${role}-b`, alwaysUnreachable)),
				);
				assert.strictEqual(replacement.role, role);
			}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect("all distinct roles hold their leases simultaneously (uniqueness is per role)", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const tracker = CrewTracker.fromClient(client);
			for (const role of CREW_ROLES) {
				const channel = yield* makeCrewChannel({role, address: `inbox://${role}`}).pipe(
					Effect.provide(channelLayers(tracker, `inbox://${role}`, alwaysUnreachable)),
				);
				assert.strictEqual(channel.role, role);
				// presence is published by the explicit announce now, not construction (#3628)
				yield* channel.announce;
			}
			// every role is independently discoverable — five distinct leases coexist
			for (const role of CREW_ROLES) {
				const result = yield* client.LookupRole({role});
				assert.lengthOf(result.peers, 1, `${role} should be present`);
			}
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);
});

describe("crew/channel-server — engine pool discovery + per-instance dial (AC 2)", () => {
	it.effect("discover returns every live engine instance, each at a distinct inbox socket", () =>
		Effect.gen(function* () {
			const engineRole = ENGINE_ROLES[0];
			const senderRole = BRIDGE_ROLES[0];
			assert(engineRole !== undefined, "the roster must carry an engine role");
			assert(senderRole !== undefined, "the roster must carry a bridge role");
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const tracker = CrewTracker.fromClient(client);

			// two engine instances of one role, distinct per-instance addresses, both live
			const addr1 = `inbox://${engineRole}/1`;
			const addr2 = `inbox://${engineRole}/2`;
			const at = new Date().toISOString();
			yield* client.AnnouncePresence({peer: addr1, role: engineRole, at});
			yield* client.AnnouncePresence({peer: addr2, role: engineRole, at});

			// a sender channel discovers the WHOLE pool, not a single collapsed holder
			const senderAddr = `inbox://${senderRole}`;
			const sender = yield* makeCrewChannel({role: senderRole, address: senderAddr}).pipe(
				Effect.provide(channelLayers(tracker, senderAddr, alwaysUnreachable)),
			);
			const pool = yield* sender.discover(engineRole);
			assert.lengthOf(pool, 2, "both engine instances are discoverable (no peers[0] collapse)");
			assert.deepStrictEqual([...pool.map((p) => p.address)].sort(), [addr1, addr2].sort());
			// two instances resolve to two DISTINCT inbox sockets — per-instance addressing, no collision
			assert.notStrictEqual(inboxSocketPathFor(addr1), inboxSocketPathFor(addr2));
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect("a sender dials ONE chosen engine instance — delivery reaches only that instance", () =>
		Effect.gen(function* () {
			const engineRole = ENGINE_ROLES[0];
			const senderRole = BRIDGE_ROLES[0];
			assert(engineRole !== undefined, "the roster must carry an engine role");
			assert(senderRole !== undefined, "the roster must carry a bridge role");
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const tracker = CrewTracker.fromClient(client);
			const addr1 = `inbox://${engineRole}/1`;
			const addr2 = `inbox://${engineRole}/2`;

			// each engine instance has its own recording channel edge, reachable by its address
			const recordingInbox = (address: string) =>
				Effect.gen(function* () {
					const wakes = yield* Ref.make<ReadonlyArray<unknown>>([]);
					const sink = Layer.succeed(ChannelSink, {
						wake: (payload) => Ref.update(wakes, (xs) => [...xs, payload]),
					});
					const inbox = yield* RpcTest.makeClient(PeerInbox).pipe(
						Effect.provide(
							Layer.provideMerge(
								inboxHandlers,
								channelInboxLayer(address).pipe(Layer.provide(sink)),
							),
						),
					);
					return {wakes, inbox};
				});
			const one = yield* recordingInbox(addr1);
			const two = yield* recordingInbox(addr2);
			const connect: Connect = (address) =>
				address === addr1
					? Effect.succeed(one.inbox)
					: address === addr2
						? Effect.succeed(two.inbox)
						: Effect.fail(new PeerUnreachableError({target: address, reason: "no route"}));

			const at = new Date().toISOString();
			yield* client.AnnouncePresence({peer: addr1, role: engineRole, at});
			yield* client.AnnouncePresence({peer: addr2, role: engineRole, at});

			// discover the pool, pick instance #2 specifically, and dial IT by address via the Dialer
			const senderAddr = `inbox://${senderRole}`;
			const ack = yield* Effect.gen(function* () {
				const dialer = yield* Dialer;
				const sender = yield* makeCrewChannel({role: senderRole, address: senderAddr});
				const pool = yield* sender.discover(engineRole);
				const chosen = pool.find((p) => p.address === addr2);
				assert(chosen !== undefined, "instance #2 is in the discovered pool");
				return yield* dialer.send(chosen.address, {
					messageId: "m-1",
					from: senderAddr,
					kind: "IntakePing",
					body: {issue: 3059},
					at: new Date().toISOString(),
				});
			}).pipe(Effect.provide(channelLayers(tracker, senderAddr, Dialer.layerFromConnect(connect))));

			assert.strictEqual(ack.by, addr2, "the ack came from instance #2's inbox");
			assert.lengthOf(yield* Ref.get(two.wakes), 1, "instance #2 received the delivery");
			assert.lengthOf(
				yield* Ref.get(one.wakes),
				0,
				"instance #1 did NOT — the dial was per-instance",
			);
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);
});
