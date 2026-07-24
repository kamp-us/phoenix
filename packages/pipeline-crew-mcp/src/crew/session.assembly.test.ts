/**
 * crew/session — the forked-stdio live-wake round-trip, closing the seam `session.ts` flags
 * unexercised (docblock line 34: "a full live-client stdio wake round-trip"). The REAL live
 * assembly (`assembleCrewSession`, the exact layer `bin.ts session --role` serves) over
 * `McpServer.layerStdio` (the forked run-loop — the live-crew transport, NOT the in-process HTTP
 * harness the other tests use) both binds the inbound peer-inbox socket AND wakes the session: a
 * dial to that socket returns an InboxAck, and `bridge.deliver` returns the ack only after
 * `sink.wake` completes through the live `ChannelSink.layerFromMcpServer` emit path, so a returned
 * ack proves the whole inbound wake fired end to end over the real stdio server.
 *
 * Uses `it.live`, not `it.effect`: `it.effect`'s virtual TestClock freezes `Effect.sleep` (the
 * forked run-loop + socket-bind settle) and the test hangs.
 */
import {randomUUID} from "node:crypto";
import {existsSync} from "node:fs";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Layer, Stdio, Stream} from "effect";
import {McpServer} from "effect/unstable/ai";
import {RpcTest} from "effect/unstable/rpc";
import {channelExperimentalCapability} from "../edge/index.ts";
import {Dialer, Inbox, PeerUnreachableError} from "../peer/index.ts";
import {TrackerRegistry} from "../tracker/group.ts";
import {TrackerHandlers} from "../tracker/handlers.ts";
import {RegistryLive} from "../tracker/registry.ts";
import {crewSocketDialerLayer, inboxSocketPathFor} from "./channel-server.ts";
import {assembleCrewSession} from "./session.ts";
import {CrewTracker, peerTrackerLayer} from "./tracker.ts";

const registryHandlers = TrackerHandlers.pipe(Layer.provide(RegistryLive));
const inMemoryCrewTracker = Layer.unwrap(
	RpcTest.makeClient(TrackerRegistry).pipe(Effect.map(CrewTracker.fromClient)),
).pipe(Layer.provide(registryHandlers));

// The sender's Dialer is stubbed to unreachable — the DIAL under test is driven separately over the
// production `crewSocketDialerLayer`, so the substrate's own dialer is never the path exercised.
const inMemorySubstrate = (address: string) =>
	Layer.mergeAll(
		inMemoryCrewTracker,
		peerTrackerLayer.pipe(Layer.provide(inMemoryCrewTracker)),
		Inbox.layer(address),
		Dialer.layerFromConnect((addr) =>
			Effect.fail(new PeerUnreachableError({target: addr, reason: "test stub dialer"})),
		),
	);

describe("crew/session — forked-stdio live-wake round-trip (session.ts:34 seam)", () => {
	it.live(
		"assembleCrewSession over layerStdio binds the inbox socket and a dial round-trips a wake back to an ack",
		() =>
			Effect.gen(function* () {
				const address = `inbox://intake-desk-stdio-${randomUUID().slice(0, 8)}`;
				const socketPath = inboxSocketPathFor(address);

				// A stdin that stays open so the forked run-loop keeps serving (the live stdio transport).
				const transport = McpServer.layerStdio({
					name: "CrewStdioTestServer",
					version: "0.0.0",
					experimental: channelExperimentalCapability,
				}).pipe(Layer.provide(Stdio.layerTest({stdin: Stream.never})));

				// The inbound socket server's stale-socket reclaim reaches disk through the `FileSystem`
				// seam; the in-memory substrate carries no `FileSystem`, so provide the real Node one —
				// discharged here exactly as the bin's `NodeServices.layer` does in production.
				const serverLayer = assembleCrewSession(
					{role: "intake-desk", projectRoot: "/x"},
					address,
					inMemorySubstrate(address),
					transport,
				).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie);

				yield* Effect.forkScoped(Layer.launch(serverLayer));
				yield* Effect.sleep("1500 millis"); // window for the forked run-loop + socket bind

				assert.isTrue(
					existsSync(socketPath),
					`the LIVE stdio assembly must bind the inbox socket at ${socketPath}`,
				);

				const ackExit = yield* Effect.gen(function* () {
					const dialer = yield* Dialer;
					return yield* dialer
						.send(address, {
							messageId: "m-stdio-1",
							from: "inbox://engineering-manager/1",
							kind: "IntakePing",
							body: {issue: 3489, from: "engineering-manager", at: new Date().toISOString()},
							at: new Date().toISOString(),
						})
						.pipe(Effect.timeout("6 seconds"));
				}).pipe(Effect.provide(crewSocketDialerLayer), Effect.exit);

				assert.isTrue(
					Exit.isSuccess(ackExit),
					`the ack must return through the live stdio layerFromMcpServer sink: ${
						Exit.isFailure(ackExit) ? Cause.pretty(ackExit.cause) : ""
					}`,
				);
			}).pipe(Effect.scoped),
		{timeout: 20000},
	);

	it.live(
		"the live assembly publishes presence only AFTER its inbox socket binds — LookupRole returns the session (#3628 AC1/AC2)",
		() =>
			Effect.gen(function* () {
				// A shared registry client, so the test can both back the session's substrate AND read
				// LookupRole against the very registry the session announces on.
				const client = yield* RpcTest.makeClient(TrackerRegistry);
				const trackerLayer = CrewTracker.fromClient(client);
				const address = `inbox://intake-desk-presence-${randomUUID().slice(0, 8)}`;
				const substrate = Layer.mergeAll(
					trackerLayer,
					peerTrackerLayer.pipe(Layer.provide(trackerLayer)),
					Inbox.layer(address),
					Dialer.layerFromConnect((addr) =>
						Effect.fail(
							new PeerUnreachableError({target: addr, reason: "presence-test stub dialer"}),
						),
					),
				);
				const transport = McpServer.layerStdio({
					name: "CrewPresenceTestServer",
					version: "0.0.0",
					experimental: channelExperimentalCapability,
				}).pipe(Layer.provide(Stdio.layerTest({stdin: Stream.never})));
				const serverLayer = assembleCrewSession(
					{role: "intake-desk", projectRoot: "/x"},
					address,
					substrate,
					transport,
				).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie);

				// Before boot: the role is not a live peer — construction/claim alone never publishes it.
				const before = yield* client.LookupRole({role: "intake-desk"});
				assert.lengthOf(before.peers, 0, "no presence before the inbox serves");

				yield* Effect.forkScoped(Layer.launch(serverLayer));
				yield* Effect.sleep("1500 millis"); // window for the socket bind + the gated announce

				const after = yield* client.LookupRole({role: "intake-desk"});
				assert.lengthOf(after.peers, 1, "presence is published once the inbox socket is serving");
				assert.strictEqual(
					after.peers[0]?.peer,
					address,
					"the announced peer is this session's inbox address",
				);
			}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
		{timeout: 20000},
	);
});
