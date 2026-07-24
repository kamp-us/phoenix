/**
 * Peer runtime behavior: a peer publishes its presence via an explicit `announce` and holds its
 * role lease for the connection lifetime; a constructed-but-unannounced peer (its inbox never
 * attached) is NOT discoverable (#3628); it sends a typed message directly to another peer's inbox
 * (not via the tracker) and gets an inbox-ack; a send to an ABSENT role surfaces a typed
 * `PeerUnreachableError`; and a send to a PRESENT role whose inbox will not answer surfaces a
 * distinguishable `ChannelDeafError` — never a silent drop.
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
import {ChannelDeafError, PeerUnreachableError} from "./errors.ts";
import {Inbox, inboxHandlers, PeerInbox} from "./inbox.ts";
import * as Peer from "./peer.ts";
import {type RolePresence, Tracker} from "./tracker.ts";

const UNREACHABLE = "@kampus/pipeline-crew-mcp/PeerUnreachableError";
const CHANNEL_DEAF = "@kampus/pipeline-crew-mcp/ChannelDeafError";

// A scoped in-memory tracker modelling the two presence phases (#3628): `reserve` holds a bare
// (undiscoverable) slot, `announce` flips it attached; both free on scope close, and `lookup`
// returns only attached entries — the same live-channel-half semantics as the real registry-core.
const FakeTracker = Layer.effect(
	Tracker,
	Effect.gen(function* () {
		const reg = yield* Ref.make<ReadonlyArray<{presence: RolePresence; attached: boolean}>>([]);
		const put = (presence: RolePresence, attached: boolean) =>
			Effect.acquireRelease(
				Ref.update(reg, (xs) => [
					...xs.filter((x) => x.presence.peer !== presence.peer),
					{presence, attached},
				]),
				() => Ref.update(reg, (xs) => xs.filter((x) => x.presence.peer !== presence.peer)),
			);
		return {
			reserve: (presence) => put(presence, false),
			announce: (presence) => put(presence, true),
			lookup: (role) =>
				Ref.get(reg).pipe(
					Effect.map((xs) =>
						Arr.findFirst(xs, (x) => x.attached && x.presence.role === role).pipe(
							Option.map((x) => x.presence),
						),
					),
				),
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
						const peer = yield* Peer.make({self: "peer-a", role: "builder", address: "addr-a"});
						yield* peer.announce;
						const present = yield* tracker.lookup("builder");
						assert.isTrue(Option.isSome(present));
					}),
				);
				// scope closed ⇒ connection dropped ⇒ lease freed
				const after = yield* tracker.lookup("builder");
				assert.isTrue(Option.isNone(after));
			}).pipe(Effect.provide([FakeTracker, Inbox.layer("peer-a"), alwaysUnreachable])),
	);

	it.effect(
		"a constructed-but-unannounced peer is NOT discoverable — presence reflects the announce, not construction (#3628)",
		() =>
			Effect.gen(function* () {
				const tracker = yield* Tracker;
				yield* Effect.scoped(
					Effect.gen(function* () {
						// The up-but-deaf case: a peer whose inbox never attached never runs `announce`, so it
						// must not appear as a live peer — "up in tmux" must not read as "registered with a live inbox".
						yield* Peer.make({self: "peer-a", role: "builder", address: "addr-a"});
						const before = yield* tracker.lookup("builder");
						assert.isTrue(Option.isNone(before), "unannounced ⇒ never a live peer");
					}),
				);
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

	it.effect(
		"send to a present role whose inbox will not answer fails with a DISTINGUISHABLE ChannelDeafError, not PeerUnreachableError (#3628 AC3)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const tracker = yield* Tracker;
					// reviewer/peer-b holds a live lease, but its inbox is deaf (the dial always fails): the
					// exact "presence reflects a socket file, not a live channel half" case.
					yield* tracker.announce({role: "reviewer", peer: "peer-b", address: "addr-b"});
					const a = yield* Peer.make({self: "peer-a", role: "builder", address: "addr-a"});
					const err = yield* a.send("reviewer", "IntakePing", {}).pipe(Effect.flip);
					assert.strictEqual(err._tag, CHANNEL_DEAF, "channel-deaf, not a generic unreachable");
					if (!(err instanceof ChannelDeafError)) {
						return assert.fail(`expected ChannelDeafError, got ${err._tag}`);
					}
					assert.strictEqual(err.target, "reviewer", "the role that is registered but deaf");
					assert.strictEqual(
						err.address,
						"addr-b",
						"the dialed inbox address that would not answer",
					);
				}),
			).pipe(Effect.provide([FakeTracker, Inbox.layer("peer-a"), alwaysUnreachable])),
	);
});
