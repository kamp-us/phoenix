/**
 * The host/dialer protocol-skew regression (#3977): a long-lived tracker host that predates a
 * protocol-kind addition serves an RPC group without the new tag, so every claim-aware
 * `EngineNudge` sent by a newer client issued `LookupClaim` into it and got `Unknown request tag:
 * LookupClaim` back — a defect that killed the whole nudge edge instead of degrading.
 *
 * The skew is real here, not stubbed: a live `RpcServer` serves the PRE-#3890 five-kind group while
 * the client speaks the current six-kind `TrackerRegistry`, wired to each other in memory the way
 * `RpcTest.makeClient` wires a matched pair. The two transport hops therefore cross two different
 * Rpc unions — that mismatch IS the subject under test, so each hop casts once.
 */
import {assert, describe, it} from "@effect/vitest";
import {Cause, Context, Effect, Exit, Layer} from "effect";
import {RpcClient, RpcGroup, RpcServer} from "effect/unstable/rpc";
import {type Connect, Dialer, Inbox, PeerUnreachableError, Tracker} from "../peer/index.ts";
import * as Peer from "../peer/peer.ts";
import {AnnouncePresence, Claim, Heartbeat, LookupRole, Release} from "../protocol/index.ts";
import {RegistryLive, TrackerHandlers, TrackerRegistry} from "../tracker/index.ts";
import {CrewTracker, peerTrackerLayer} from "./tracker.ts";

/** The registry group a pre-#3890 tracker host serves: the five kinds it booted with, no `LookupClaim`. */
const PreClaimLookupRegistry = RpcGroup.make(
	Claim,
	Release,
	AnnouncePresence,
	LookupRole,
	Heartbeat,
);

const registryHandlers = TrackerHandlers.pipe(Layer.provide(RegistryLive));

/**
 * A client of the CURRENT `TrackerRegistry` talking to a server of the PRE-#3890 group — the
 * skewed pair. `LookupClaim` reaches a server whose `group.requests` has no such tag, which is
 * where `RpcServer` answers `Exit.die("Unknown request tag: LookupClaim")`.
 */
const skewedRegistryClient = Effect.gen(function* () {
	const toClient: {current: (response: unknown) => Effect.Effect<void>} = {
		current: () => Effect.die("skew harness: the tracker answered before the client was wired"),
	};
	const server = yield* RpcServer.makeNoSerialization(PreClaimLookupRegistry, {
		onFromServer: (response) => toClient.current(response),
	});
	const client = yield* RpcClient.makeNoSerialization(TrackerRegistry, {
		supportsAck: true,
		onFromClient: ({message}) => server.write(0, message as Parameters<typeof server.write>[1]),
	});
	toClient.current = client.write as (response: unknown) => Effect.Effect<void>;
	return client.client;
});

const buildInbox = (id: string) =>
	Layer.build(Inbox.layer(id)).pipe(Effect.map((ctx) => Context.get(ctx, Inbox)));

describe("crew/tracker — a claim-aware send survives a skewed tracker host (#3977)", () => {
	it.effect("LookupClaim into a pre-#3890 host dies with the reported unknown-tag defect", () =>
		Effect.gen(function* () {
			const client = yield* skewedRegistryClient;
			const exit = yield* Effect.exit(client.LookupClaim({resource: "pr-3951"}));
			assert.isTrue(Exit.isFailure(exit), "the skewed host rejects the tag it never registered");
			if (Exit.isFailure(exit)) {
				assert.include(String(Cause.squash(exit.cause)), "Unknown request tag: LookupClaim");
			}
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect(
		"an EngineNudge about a claimed PR still DELIVERS — it degrades to the broadcast fan",
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
					const client = yield* skewedRegistryClient;

					yield* Effect.gen(function* () {
						const tracker = yield* Tracker;
						// peer-id ≡ inbox-address in the crew binding, so a seat announces at its dialable address.
						yield* tracker.announce({
							role: "engineering-manager",
							peer: "addr-head",
							address: "addr-head",
						});
						yield* tracker.announce({
							role: "engineering-manager",
							peer: "addr-owner",
							address: "addr-owner",
						});
						const cos = yield* Peer.make({
							self: "cos",
							role: "chief-of-staff",
							address: "addr-cos",
						});
						// The exact reported send: cartographer/chief-of-staff → an engine role, kind EngineNudge,
						// target a PR — the only kind that derives a claim key. Before the fix this died with
						// `Unknown request tag: LookupClaim`; now the unresolvable claim keeps the #3770 fan.
						const ack = yield* cos.send(
							"engineering-manager",
							"EngineNudge",
							{
								target: {pr: 3951},
								from: "cartographer",
								note: "look at this",
								at: new Date().toISOString(),
							},
							{claimResource: "pr-3951"},
						);
						assert.isString(ack.by, "the send resolved to a delivery receipt, not a defect");
						assert.lengthOf(yield* headSeat.received, 1, "head seat received the nudge");
						assert.lengthOf(
							yield* ownerSeat.received,
							1,
							"the other seat received it too — a full fan",
						);
					}).pipe(
						Effect.provide([
							peerTrackerLayer.pipe(Layer.provide(CrewTracker.fromClient(client))),
							Inbox.layer("cos"),
							Dialer.layerFromConnect(connect),
						]),
					);
				}).pipe(Effect.provide(registryHandlers)),
			),
	);
});
