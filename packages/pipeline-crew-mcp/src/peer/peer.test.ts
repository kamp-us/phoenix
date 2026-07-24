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
import {Context, Effect, Layer, Option, Ref, Result} from "effect";
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
// returns EVERY attached holder of a role (in announce order) — one for a bridge, N for an engine
// pool — the same live-set semantics as the real registry-core (#3770). `claims` seeds the
// resource-claim keyspace (resource-key → holder address); `claimHolder` resolves a claim only when
// its holder is CURRENTLY attached, mirroring registry-core's presence-derived claim liveness
// (a claim whose holder lapsed reads as unclaimed, ADR 0191 facet 2).
const makeFakeTracker = (claims: ReadonlyMap<string, string> = new Map()) =>
	Layer.effect(
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
							Arr.filterMap(xs, (x) =>
								x.attached && x.presence.role === role
									? Result.succeed(x.presence)
									: Result.failVoid,
							),
						),
					),
				claimHolder: (resource) => {
					const holder = claims.get(resource);
					if (holder === undefined) return Effect.succeed(Option.none<string>());
					return Ref.get(reg).pipe(
						Effect.map((xs) =>
							xs.some((x) => x.attached && x.presence.address === holder)
								? Option.some(holder)
								: Option.none<string>(),
						),
					);
				},
			};
		}),
	);

// The default fake with an empty claim keyspace — the pre-claim-aware behavior the existing tests assert.
const FakeTracker = makeFakeTracker();

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
						assert.lengthOf(present, 1);
					}),
				);
				// scope closed ⇒ connection dropped ⇒ lease freed
				const after = yield* tracker.lookup("builder");
				assert.lengthOf(after, 0);
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
						assert.lengthOf(before, 0, "unannounced ⇒ never a live peer");
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

describe("peer/peer — fan a role send across an engine pool (count>1, #3770)", () => {
	// A standalone in-memory inbox whose Deliver IS its own deliver, so the test can both DIAL it
	// (via the connect) and READ what it received — the two halves the fan assertion needs.
	const buildInbox = (id: string) =>
		Layer.build(Inbox.layer(id)).pipe(Effect.map((ctx) => Context.get(ctx, Inbox)));

	it.effect(
		"an EngineNudge to a role with TWO live holders reaches BOTH seats — the head AND the non-head owner",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const headSeat = yield* buildInbox("em-head");
					const ownerSeat = yield* buildInbox("em-owner");
					// route each announced address to its inbox; anything else is off the network
					const connect: Connect = (address) =>
						address === "addr-head"
							? Effect.succeed({Deliver: headSeat.deliver})
							: address === "addr-owner"
								? Effect.succeed({Deliver: ownerSeat.deliver})
								: Effect.fail(new PeerUnreachableError({target: address, reason: "no route"}));

					yield* Effect.gen(function* () {
						const tracker = yield* Tracker;
						// two engine seats under ONE role — announce order makes em-head the head the old
						// `Arr.head` resolver would have picked; em-owner is the seat it could never reach.
						yield* tracker.announce({
							role: "engineering-manager",
							peer: "em-head",
							address: "addr-head",
						});
						yield* tracker.announce({
							role: "engineering-manager",
							peer: "em-owner",
							address: "addr-owner",
						});
						const cos = yield* Peer.make({
							self: "cos",
							role: "chief-of-staff",
							address: "addr-cos",
						});
						yield* cos.send("engineering-manager", "EngineNudge", {target: {pr: 3838}});

						const gotHead = yield* headSeat.received;
						const gotOwner = yield* ownerSeat.received;
						assert.lengthOf(gotHead, 1, "the head seat received the nudge");
						assert.lengthOf(
							gotOwner,
							1,
							"the NON-head seat received the nudge too — the count>1 fix (#3770)",
						);
						assert.strictEqual(gotHead[0]?.kind, "EngineNudge");
						assert.strictEqual(gotOwner[0]?.kind, "EngineNudge");
						// one logical message fanned to both seats, not two distinct sends
						assert.strictEqual(
							gotHead[0]?.messageId,
							gotOwner[0]?.messageId,
							"the same envelope reached both seats",
						);
					}).pipe(
						Effect.provide([FakeTracker, Inbox.layer("cos"), Dialer.layerFromConnect(connect)]),
					);
				}),
			),
	);

	it.effect(
		"an EngineNudge about a CLAIMED resource routes to the claim HOLDER's seat only, sparing the non-owning seat (#3886)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const ownerSeat = yield* buildInbox("em-owner");
					const otherSeat = yield* buildInbox("em-other");
					const connect: Connect = (address) =>
						address === "addr-owner"
							? Effect.succeed({Deliver: ownerSeat.deliver})
							: address === "addr-other"
								? Effect.succeed({Deliver: otherSeat.deliver})
								: Effect.fail(new PeerUnreachableError({target: address, reason: "no route"}));

					yield* Effect.gen(function* () {
						const tracker = yield* Tracker;
						yield* tracker.announce({
							role: "engineering-manager",
							peer: "em-owner",
							address: "addr-owner",
						});
						yield* tracker.announce({
							role: "engineering-manager",
							peer: "em-other",
							address: "addr-other",
						});
						const cos = yield* Peer.make({
							self: "cos",
							role: "chief-of-staff",
							address: "addr-cos",
						});
						// addr-owner holds the claim on `issue-3886` (the canonical NudgeTarget key), so the send
						// naming that key delivers to that seat ONLY — addr-other is not dialed.
						const ack = yield* cos.send(
							"engineering-manager",
							"EngineNudge",
							{target: {issue: 3886}},
							{claimResource: "issue-3886"},
						);
						assert.strictEqual(ack.by, "em-owner", "acked by the claim holder's seat");
						assert.lengthOf(yield* ownerSeat.received, 1, "the claim holder received the nudge");
						assert.lengthOf(
							yield* otherSeat.received,
							0,
							"the NON-owning seat was spared — claim-aware routing narrowed the fan (#3886)",
						);
					}).pipe(
						Effect.provide([
							makeFakeTracker(new Map([["issue-3886", "addr-owner"]])),
							Inbox.layer("cos"),
							Dialer.layerFromConnect(connect),
						]),
					);
				}),
			),
	);

	it.effect(
		"an EngineNudge whose target is UNCLAIMED still fans to every seat (claim-aware routing only narrows a resolved claim, #3886)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const headSeat = yield* buildInbox("em-head");
					const ownerSeat = yield* buildInbox("em-owner");
					const connect: Connect = (address) =>
						address === "addr-head"
							? Effect.succeed({Deliver: headSeat.deliver})
							: address === "addr-owner"
								? Effect.succeed({Deliver: ownerSeat.deliver})
								: Effect.fail(new PeerUnreachableError({target: address, reason: "no route"}));

					yield* Effect.gen(function* () {
						const tracker = yield* Tracker;
						yield* tracker.announce({
							role: "engineering-manager",
							peer: "em-head",
							address: "addr-head",
						});
						yield* tracker.announce({
							role: "engineering-manager",
							peer: "em-owner",
							address: "addr-owner",
						});
						const cos = yield* Peer.make({
							self: "cos",
							role: "chief-of-staff",
							address: "addr-cos",
						});
						// The key is supplied but NO claim exists for it — claimHolder resolves None, so the send fans.
						yield* cos.send(
							"engineering-manager",
							"EngineNudge",
							{target: {issue: 3886}},
							{claimResource: "issue-3886"},
						);
						assert.lengthOf(yield* headSeat.received, 1, "head seat received the broadcast");
						assert.lengthOf(yield* ownerSeat.received, 1, "owner seat received the broadcast");
					}).pipe(
						Effect.provide([FakeTracker, Inbox.layer("cos"), Dialer.layerFromConnect(connect)]),
					);
				}),
			),
	);

	it.effect(
		"a claim whose holder's presence has LAPSED is treated as unclaimed, so the nudge fans (claims ride presence, ADR 0191 facet 2)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const headSeat = yield* buildInbox("em-head");
					const ownerSeat = yield* buildInbox("em-owner");
					const connect: Connect = (address) =>
						address === "addr-head"
							? Effect.succeed({Deliver: headSeat.deliver})
							: address === "addr-owner"
								? Effect.succeed({Deliver: ownerSeat.deliver})
								: Effect.fail(new PeerUnreachableError({target: address, reason: "no route"}));

					yield* Effect.gen(function* () {
						const tracker = yield* Tracker;
						yield* tracker.announce({
							role: "engineering-manager",
							peer: "em-head",
							address: "addr-head",
						});
						yield* tracker.announce({
							role: "engineering-manager",
							peer: "em-owner",
							address: "addr-owner",
						});
						const cos = yield* Peer.make({
							self: "cos",
							role: "chief-of-staff",
							address: "addr-cos",
						});
						// The claim points at addr-ghost, which never announced (no live presence), so claimHolder
						// resolves None — the lapsed-claim-reads-as-unclaimed path — and the send fans to all seats.
						yield* cos.send(
							"engineering-manager",
							"EngineNudge",
							{target: {issue: 3886}},
							{claimResource: "issue-3886"},
						);
						assert.lengthOf(yield* headSeat.received, 1, "head seat received the broadcast");
						assert.lengthOf(yield* ownerSeat.received, 1, "owner seat received the broadcast");
					}).pipe(
						Effect.provide([
							makeFakeTracker(new Map([["issue-3886", "addr-ghost"]])),
							Inbox.layer("cos"),
							Dialer.layerFromConnect(connect),
						]),
					);
				}),
			),
	);

	it.effect(
		"a fan tolerates a deaf seat in the pool — one holder deaf, another live still delivers (ack from the live seat)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const liveSeat = yield* buildInbox("em-live");
					// addr-live answers; addr-deaf is announced but unreachable (a stale-socket seat)
					const connect: Connect = (address) =>
						address === "addr-live"
							? Effect.succeed({Deliver: liveSeat.deliver})
							: Effect.fail(new PeerUnreachableError({target: address, reason: "no route"}));

					yield* Effect.gen(function* () {
						const tracker = yield* Tracker;
						yield* tracker.announce({
							role: "engineering-manager",
							peer: "em-deaf",
							address: "addr-deaf",
						});
						yield* tracker.announce({
							role: "engineering-manager",
							peer: "em-live",
							address: "addr-live",
						});
						const cos = yield* Peer.make({
							self: "cos",
							role: "chief-of-staff",
							address: "addr-cos",
						});
						const ack = yield* cos.send("engineering-manager", "EngineNudge", {
							target: {issue: 3641},
						});
						assert.strictEqual(
							ack.by,
							"em-live",
							"delivered — the live seat acked despite a deaf pool-mate",
						);
						const gotLive = yield* liveSeat.received;
						assert.lengthOf(gotLive, 1, "the live seat received the nudge");
					}).pipe(
						Effect.provide([FakeTracker, Inbox.layer("cos"), Dialer.layerFromConnect(connect)]),
					);
				}),
			),
	);
});

describe("peer/peer — selectDeliveryTargets (the pure claim-aware selection, #3886)", () => {
	const holder = (peer: string, address: string): RolePresence => ({
		role: "engineering-manager",
		peer,
		address,
	});
	const pool = [holder("a", "addr-a"), holder("b", "addr-b")] as const;

	it("no claim owner falls back to the whole live pool (the broadcast fan)", () => {
		assert.deepStrictEqual(Peer.selectDeliveryTargets(pool, Option.none()), pool);
	});

	it("a claim owner that is a live holder narrows to that one seat", () => {
		assert.deepStrictEqual(Peer.selectDeliveryTargets(pool, Option.some("addr-b")), [
			holder("b", "addr-b"),
		]);
	});

	it("a claim owner not among the live holders falls back to the full fan (never an empty set)", () => {
		assert.deepStrictEqual(Peer.selectDeliveryTargets(pool, Option.some("addr-ghost")), pool);
	});
});
