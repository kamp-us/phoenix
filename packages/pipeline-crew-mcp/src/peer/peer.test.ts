/**
 * Peer runtime behavior (ACs 1–3): a peer announces + holds its role lease for the
 * connection lifetime; sends a typed message directly to another peer's inbox (not via the
 * tracker) and gets an inbox-ack; and a send to an offline peer — absent role OR a dial
 * that fails — surfaces a typed `PeerUnreachableError`, never a silent drop.
 *
 * The tracker is a per-project registry (#3055); here it is an in-memory fake whose
 * `announce` is scoped, so lease-lifetime is observable: present while the peer's scope is
 * open, gone once it closes (connection-is-lease, #3035).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Option, Ref} from "effect";
import * as Arr from "effect/Array";
import {RpcTest} from "effect/unstable/rpc";
import {type Connect, Dialer} from "./dialer.ts";
import {PeerUnreachableError} from "./errors.ts";
import {Inbox, inboxHandlers, PeerInbox} from "./inbox.ts";
import * as Peer from "./peer.ts";
import {type RolePresence, Tracker} from "./tracker.ts";

const UNREACHABLE = "@kampus/pipeline-crew-mcp/PeerUnreachableError";

// A scoped in-memory tracker: announce acquires presence and releases it on scope close.
const FakeTracker = Layer.effect(
	Tracker,
	Effect.gen(function* () {
		const reg = yield* Ref.make<ReadonlyArray<RolePresence>>([]);
		return {
			announce: (presence) =>
				Effect.acquireRelease(
					Ref.update(reg, (xs) => [...xs, presence]),
					() => Ref.update(reg, (xs) => xs.filter((x) => x !== presence)),
				),
			lookup: (role) =>
				Ref.get(reg).pipe(Effect.map((xs) => Arr.findFirst(xs, (x) => x.role === role))),
		};
	}),
);

// A dialer that always fails — for tests where the dial must never be the thing under test.
const alwaysUnreachable = Dialer.layerFromConnect((address) =>
	Effect.fail(new PeerUnreachableError({target: address, reason: "no route"})),
);

describe("peer/peer — announce + role lease", () => {
	it.effect(
		"holds its role lease for the connection lifetime (present while alive, freed on close)",
		() =>
			Effect.gen(function* () {
				const tracker = yield* Tracker;
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* Peer.make({self: "peer-a", role: "builder", address: "addr-a"});
						const present = yield* tracker.lookup("builder");
						assert.isTrue(Option.isSome(present));
					}),
				);
				// scope closed ⇒ connection dropped ⇒ lease freed
				const after = yield* tracker.lookup("builder");
				assert.isTrue(Option.isNone(after));
			}).pipe(Effect.provide([FakeTracker, Inbox.layer("peer-a"), alwaysUnreachable])),
	);
});

describe("peer/peer — direct peer-to-peer send", () => {
	it.effect("sends to a target's inbox directly and receives its inbox-ack", () =>
		Effect.scoped(
			Effect.gen(function* () {
				// peer B's in-memory inbox, reachable at addr-b
				const bClient = yield* RpcTest.makeClient(PeerInbox).pipe(
					Effect.provide(Layer.provideMerge(inboxHandlers, Inbox.layer("peer-b"))),
				);
				const connect: Connect = (address) =>
					address === "addr-b"
						? Effect.succeed(bClient)
						: Effect.fail(new PeerUnreachableError({target: address, reason: "no route"}));

				yield* Effect.gen(function* () {
					const tracker = yield* Tracker;
					yield* tracker.announce({role: "reviewer", peer: "peer-b", address: "addr-b"});
					const a = yield* Peer.make({self: "peer-a", role: "builder", address: "addr-a"});
					const ack = yield* a.send("reviewer", "IntakePing", {issue: 3056});
					// acked BY peer-b's inbox ⇒ it went straight to B, not through the tracker.
					assert.strictEqual(ack.by, "peer-b");
				}).pipe(
					Effect.provide([FakeTracker, Inbox.layer("peer-a"), Dialer.layerFromConnect(connect)]),
				);
			}),
		),
	);
});

describe("peer/peer — offline behavior (never a silent drop)", () => {
	it.effect("send to an absent role fails with PeerUnreachableError", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const a = yield* Peer.make({self: "peer-a", role: "builder", address: "addr-a"});
				const err = yield* a.send("ghost", "IntakePing", {}).pipe(Effect.flip);
				assert.strictEqual(err._tag, UNREACHABLE);
				assert.strictEqual(err.target, "ghost");
			}),
		).pipe(Effect.provide([FakeTracker, Inbox.layer("peer-a"), alwaysUnreachable])),
	);

	it.effect("send to a present-but-unreachable peer fails with PeerUnreachableError", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const tracker = yield* Tracker;
				yield* tracker.announce({role: "reviewer", peer: "peer-b", address: "addr-b"});
				const a = yield* Peer.make({self: "peer-a", role: "builder", address: "addr-a"});
				const err = yield* a.send("reviewer", "IntakePing", {}).pipe(Effect.flip);
				assert.strictEqual(err._tag, UNREACHABLE);
				assert.strictEqual(err.target, "addr-b");
			}),
		).pipe(Effect.provide([FakeTracker, Inbox.layer("peer-a"), alwaysUnreachable])),
	);
});
