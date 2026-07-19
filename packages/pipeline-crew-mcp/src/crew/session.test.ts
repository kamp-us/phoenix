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
import {randomUUID} from "node:crypto";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Deferred, Effect, Layer, Ref, Schema, Stdio, Stream} from "effect";
import {McpSchema, McpServer} from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {RpcSerialization, RpcTest} from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type {ChannelNotificationPayload} from "../edge/index.ts";
import {
	CHANNEL_CAPABILITY,
	ChannelSend,
	ChannelSink,
	channelExperimentalCapability,
	channelInboxLayer,
} from "../edge/index.ts";
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
import {CREW_ROLES, kindOf} from "./roles.ts";
import {
	assembleCrewSession,
	channelSendFromPeer,
	inboxAddressFor,
	sessionInstance,
} from "./session.ts";
import {CrewTracker, peerTrackerLayer, type TrackerRegistryClient} from "./tracker.ts";

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
			const senderAddress = inboxAddressFor(senderRole, "sender");
			const receiverAddress = inboxAddressFor(receiverRole, "receiver");

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
				return yield* sender.send(receiverRole, "IntakePing", {issue: 3062, from: senderRole});
			}).pipe(
				Effect.provide(
					channelSendFromPeer(senderRole, senderAddress).pipe(
						Layer.provide(substrate(tracker, senderAddress, Dialer.layerFromConnect(connect))),
					),
				),
			);

			// Delivered straight to the receiver's inbox (peer→peer, the tracker never relays).
			assert.strictEqual(ack.by, receiverAddress, "acked by the receiver's inbox ⇒ it went to it");
			const recorded = yield* Ref.get(wakes);
			assert.lengthOf(recorded, 1);
			assert.match(recorded[0]?.content ?? "", /IntakePing/, "the seam rode a channel wake");
			assert.strictEqual(recorded[0]?.meta?.from, senderAddress);
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect("a send to an offline role surfaces as a typed unreachable, never a silent drop", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const tracker = CrewTracker.fromClient(client);
			const [senderRole, offlineRole] = [CREW_ROLES[0], CREW_ROLES[2]];
			const senderAddress = inboxAddressFor(senderRole, "sender");
			const alwaysUnreachable = Dialer.layerFromConnect((address) =>
				Effect.fail(new PeerUnreachableError({target: address, reason: "no route"})),
			);

			const failure = yield* Effect.gen(function* () {
				const sender = yield* ChannelSend;
				return yield* sender.send(offlineRole, "IntakePing", {});
			}).pipe(
				Effect.provide(
					channelSendFromPeer(senderRole, senderAddress).pipe(
						Layer.provide(substrate(tracker, senderAddress, alwaysUnreachable)),
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
		const addresses = CREW_ROLES.map((role) => inboxAddressFor(role, "i"));
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

describe("crew/session — per-instance engine addressing (AC 1)", () => {
	const engineRole = CREW_ROLES.find((role) => kindOf(role) === "engine");
	const bridgeRole = CREW_ROLES.find((role) => kindOf(role) === "bridge");

	it("a bridge keeps the deterministic singleton address, ignoring the instance", () => {
		assert(bridgeRole !== undefined, "the roster must carry a bridge role");
		assert.strictEqual(inboxAddressFor(bridgeRole, "one"), `inbox://${bridgeRole}`);
		assert.strictEqual(
			inboxAddressFor(bridgeRole, "one"),
			inboxAddressFor(bridgeRole, "two"),
			"a bridge's cardinality-1 lease keeps discover→dial deterministic — no instance in the address",
		);
	});

	it("an engine folds the instance in — two instances resolve to two distinct addresses", () => {
		assert(engineRole !== undefined, "the roster must carry an engine role");
		const one = inboxAddressFor(engineRole, "one");
		const two = inboxAddressFor(engineRole, "two");
		assert.strictEqual(one, `inbox://${engineRole}/one`);
		assert.notStrictEqual(one, two, "N engine instances never collapse onto a single address");
	});
});

describe("crew/session — sessionInstance honors the launcher-assigned identity (#3445 AC 2)", () => {
	const engineRole = CREW_ROLES.find((role) => kindOf(role) === "engine");
	const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	it("binds the passed instance when present, not a freshly minted one", () => {
		assert(engineRole !== undefined, "the roster must carry an engine role");
		const instance = "launcher-assigned-uuid";
		assert.strictEqual(
			sessionInstance({role: engineRole, projectRoot: "/x", instance}),
			instance,
			"the launcher-assigned instance is honored — the engine binds THAT address, not a self-mint",
		);
	});

	it("mints a fresh UUID when absent (the bridge/singleton or direct-run case)", () => {
		assert(engineRole !== undefined, "the roster must carry an engine role");
		const config = {role: engineRole, projectRoot: "/x"};
		const minted = sessionInstance(config);
		assert.match(minted, UUID_RE, "absent ⇒ a minted UUID, preserving pre-#3445 behavior");
		assert.notStrictEqual(
			minted,
			sessionInstance(config),
			"each absent-instance resolution mints a distinct id",
		);
	});
});

// A dispose() rejection is irrelevant to teardown; surface it as a typed failure and swallow it
// (never Effect.promise, whose rejection escapes as an uncatchable defect — .patterns/index.md #2736).
class DisposeError extends Schema.TaggedErrorClass<DisposeError>()(
	"@kampus/pipeline-crew-mcp/crew/DisposeError",
	{cause: Schema.Unknown},
) {}

/**
 * The in-memory substrate for the outbound `ChannelSend` binding: an `RpcTest`-backed `CrewTracker`
 * (so `makeCrewChannel`'s role-lease claim + presence announce succeed when the outbound layer is
 * BUILT) + the peer ports + a stub dialer. `channel_send` is only REGISTERED here, never called
 * during `tools/list`, so the dialer need only exist.
 */
const inMemoryCrewTracker = Layer.unwrap(
	RpcTest.makeClient(TrackerRegistry).pipe(Effect.map(CrewTracker.fromClient)),
).pipe(Layer.provide(registryHandlers));
const inMemorySubstrate = (address: string) =>
	Layer.mergeAll(
		inMemoryCrewTracker,
		peerTrackerLayer.pipe(Layer.provide(inMemoryCrewTracker)),
		Inbox.layer(address),
		Dialer.layerFromConnect((addr) =>
			Effect.fail(new PeerUnreachableError({target: addr, reason: "test stub dialer"})),
		),
	);

/**
 * Boot the SESSION-MODE server assembly (`assembleCrewSession`) in-process over `McpServer.layerHttp`
 * — the same assembly `bin.ts session --role` serves over stdio, minus the stdio transport — and
 * return an initialized MCP client of it. Mirrors the in-memory harness in `edge/mcp-channel.test.ts`:
 * a `HttpRouter.toWebHandler` + a session-replaying `customFetch` drive the real served server, so the
 * advertised `tools/list` + `capabilities.experimental` are observable without a live stdio client.
 */
const bootSessionClient = (address: string) =>
	Effect.gen(function* () {
		const serverLayer = assembleCrewSession(
			{role: CREW_ROLES[0], projectRoot: "/x"},
			address,
			inMemorySubstrate(address),
			McpServer.layerHttp({
				name: "CrewSessionTestServer",
				version: "0.0.0",
				path: "/mcp",
				experimental: channelExperimentalCapability,
			}),
			// The inbound socket server's stale-socket reclaim reaches disk through the `FileSystem`
			// seam; the in-memory substrate carries none, so provide the real Node one (as the bin does).
		).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie);
		const {dispose, handler} = HttpRouter.toWebHandler(serverLayer, {disableLogger: true});
		yield* Effect.addFinalizer(() =>
			Effect.tryPromise({try: () => dispose(), catch: (cause) => new DisposeError({cause})}).pipe(
				Effect.ignore,
			),
		);

		let sessionId: string | null = null;
		const customFetch: typeof fetch = async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			if (sessionId) request.headers.set("Mcp-Session-Id", sessionId);
			const response = await handler(request);
			sessionId = response.headers.get("Mcp-Session-Id");
			return response;
		};
		const clientLayer = RpcClient.layerProtocolHttp({url: "http://localhost/mcp"}).pipe(
			Layer.provideMerge([FetchHttpClient.layer, RpcSerialization.layerJsonRpc()]),
			Layer.provide(Layer.succeed(FetchHttpClient.Fetch, customFetch)),
		);
		const client = yield* RpcClient.make(McpSchema.ClientRpcs).pipe(Effect.provide(clientLayer));
		const initialized = yield* client.initialize({
			protocolVersion: "9999-01-01",
			capabilities: {},
			clientInfo: {name: "TestClient", version: "0.0.0"},
		});
		return {client, initialized};
	});

/**
 * A substrate whose `CrewTracker.claim` BLOCKS on `gate` before granting — the in-memory stand-in for
 * the slow unix-socket tracker handshake `makeCrewChannel` runs when it builds `ChannelSend`. It runs
 * `onClaim` the instant it unblocks (past the gate), so a test can record WHEN the async `ChannelSend`
 * resolves relative to the served transport. Everything else (announce/lookup/heartbeat) is the real
 * in-memory registry, so `makeCrewChannel`'s presence announce + role-lease claim behave normally.
 */
const gatedRaceSubstrate = (
	address: string,
	gate: Deferred.Deferred<void>,
	onClaim: Effect.Effect<void>,
) => {
	const tracker = Layer.unwrap(
		RpcTest.makeClient(TrackerRegistry).pipe(
			Effect.map((client) => {
				const gatedClient: TrackerRegistryClient = {
					Claim: (payload) =>
						Deferred.await(gate).pipe(
							Effect.andThen(onClaim),
							Effect.andThen(client.Claim(payload)),
						),
					Release: (payload) => client.Release(payload),
					AnnouncePresence: (payload) => client.AnnouncePresence(payload),
					LookupRole: (payload) => client.LookupRole(payload),
					Heartbeat: (payload) => client.Heartbeat(payload),
				};
				return CrewTracker.fromClient(gatedClient);
			}),
		),
	).pipe(Layer.provide(registryHandlers));
	return Layer.mergeAll(
		tracker,
		peerTrackerLayer.pipe(Layer.provide(tracker)),
		Inbox.layer(address),
		Dialer.layerFromConnect((addr) =>
			Effect.fail(new PeerUnreachableError({target: addr, reason: "race-test stub dialer"})),
		),
	);
};

describe("crew/session — the session-mode server wins the async-ChannelSend build race (#3479 defect B)", () => {
	// The advertisement guard below drives a synchronous in-memory ChannelSend, so registration wins the
	// race and it passes EVEN with the pre-fix ordering — it cannot reproduce the live stdio symptom. This
	// test injects an ASYNC ChannelSend (the gated tracker-claim) and asserts the toolkit registers BEFORE
	// the forked stdio run-loop begins serving, so a client's `initialize` never sees `server.tools === []`.
	// It FAILS on the old (transport-built-then-async-toolkit) ordering and PASSES on the claim-first fix.
	// `it.live` (not `it.effect`): the race turns on REAL async scheduling — the forked run-loop, socket
	// I/O, the timed gate release — so it must run on the live clock, not `it.effect`'s TestClock.
	it.live(
		"the channel_send toolkit registers before the forked run-loop serves, even with an async ChannelSend",
		() =>
			Effect.gen(function* () {
				const address = `inbox://race-test-${randomUUID()}`;
				const order = yield* Ref.make<ReadonlyArray<string>>([]);
				const claimGate = yield* Deferred.make<void>();
				// One Deferred per event, so the assertion waits for BOTH to land (no fixed-sleep guess): the
				// event log records ORDER, the Deferreds record OCCURRENCE.
				const servedAt = yield* Deferred.make<void>();
				const resolvedAt = yield* Deferred.make<void>();
				const mark = (label: string, at: Deferred.Deferred<void>) =>
					Ref.update(order, (xs) => [...xs, label]).pipe(
						Effect.andThen(Deferred.succeed(at, undefined)),
						Effect.asVoid,
					);

				// The async ChannelSend: makeCrewChannel's tracker-claim blocks on claimGate (the slow socket
				// handshake) and records "channel-resolved" the instant it unblocks — the point the toolkit can
				// finally register channel_send.
				const substrate = gatedRaceSubstrate(
					address,
					claimGate,
					mark("channel-resolved", resolvedAt),
				);

				// A fake Stdio whose stdin records "serving-started" the instant the transport's run-loop begins
				// consuming it, then blocks forever (Stream.never) so the run-loop stays live. This is the
				// observable proxy for "the server is now able to answer initialize" — the exact moment
				// channel_send must ALREADY be on server.tools (Effect gates capabilities.tools on tools.length).
				const stdin = Stream.fromEffect(mark("serving-started", servedAt)).pipe(
					Stream.drain,
					Stream.concat(Stream.never),
				);
				const transport = McpServer.layerStdio({
					name: "CrewRaceTestServer",
					version: "0.0.0",
					experimental: channelExperimentalCapability,
				}).pipe(Layer.provide(Stdio.layerTest({stdin})));

				const serverLayer = assembleCrewSession(
					{role: CREW_ROLES[0], projectRoot: "/x"},
					address,
					substrate,
					transport,
					// Provide the real Node `FileSystem` for the inbound reclaim seam (as the bin does).
				).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie);

				// Launch the live session on a scoped fiber. Claim-first (fixed): it blocks in the unwrap on the
				// gated claim, so nothing serves until the gate opens. Old ordering: the transport builds and its
				// run-loop starts serving while the toolkit still awaits the gated ChannelSend.
				yield* Effect.forkScoped(Layer.launch(serverLayer));

				// Give the OLD ordering's forked run-loop a window to record "serving-started" before the gate
				// opens — so on the bug the order is [serving-started, channel-resolved]. The fix records nothing
				// until the gate opens (the claim gates the whole build), then [channel-resolved, serving-started];
				// on the fix channel-resolved ALWAYS precedes serving-started regardless of this delay.
				yield* Effect.sleep("100 millis");
				yield* Deferred.succeed(claimGate, undefined);

				// Wait for BOTH events to occur, then read the order they landed in.
				yield* Deferred.await(servedAt);
				yield* Deferred.await(resolvedAt);
				const recorded = yield* Ref.get(order);
				assert.strictEqual(
					recorded[0],
					"channel-resolved",
					"channel_send must be registered (ChannelSend resolved) BEFORE the run-loop serves initialize — else a client sees Capabilities: none and never lists the tool",
				);
			}),
	);
});

describe("crew/session — the session-mode server advertises the channel edge (#3479 defect B)", () => {
	it.effect(
		"its tools/list exposes channel_send AND it advertises the claude/channel capability",
		() =>
			Effect.gen(function* () {
				// Unique address ⇒ a collision-free inbox socket path, so parallel test files never clash.
				const address = `inbox://session-mode-test-${randomUUID()}`;
				const {client, initialized} = yield* bootSessionClient(address);

				// The `claude/channel` experimental capability rides the initialize response (from the one
				// served McpServer's serverInfo.experimental).
				assert.isDefined(
					initialized.capabilities.experimental,
					"the served server must advertise an experimental capability set",
				);
				assert.deepEqual(
					initialized.capabilities.experimental?.[CHANNEL_CAPABILITY],
					{},
					"the served session must advertise the claude/channel capability",
				);

				// channel_send must be in the served server's tools/list — the outbound toolkit registered
				// on the same instance the transport serves. Regression guard for the #3479 completing bar
				// ("a session can call channel_send"): it pins that `assembleCrewSession` advertises the tool
				// over a real served transport, so a future recomposition that splits the served instance
				// from the toolkit's is caught in-process. NB: this in-process HTTP harness advertises under
				// BOTH the merge-once and the old per-registration provide (McpServer.layer memoizes across
				// the single build), so it does NOT by itself reproduce the live stdio `/mcp` Capabilities:
				// none symptom — that final check is EA's live re-boot (see PR notes).
				const listed = yield* client["tools/list"]({});
				const names = listed.tools.map((tool) => tool.name);
				assert.include(names, "channel_send", "the model must be able to call channel_send");
			}).pipe(Effect.scoped),
	);
});
