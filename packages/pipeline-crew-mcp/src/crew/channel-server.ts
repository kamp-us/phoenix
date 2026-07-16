/**
 * crew/channel-server — the wiring: compose the generic substrate (tracker + peer + edge)
 * into a per-role channel server for one crew role. This is the composition root the whole
 * package builds toward — `crew/` imports the generic modules; they never import back (the
 * one-way boundary in `../index.ts`).
 *
 * The shape is transport-injected on purpose: `makeCrewChannel` needs only the abstract seams
 * (`CrewTracker`, the peer `Inbox`/`Dialer`/`Tracker` ports) in context, so the tests drive it
 * fully in-memory (`RpcTest` client + an in-memory connect) while production supplies the socket
 * bindings below. The one crew-specific rule the wiring enforces that the generic peer does not:
 * the role-uniqueness lease — a session claims its ROLE up front, and a second live session for a
 * held role is rejected (`RoleUniquenessError`), never allowed to co-occupy it.
 *
 * The runnable stdio entry (the edge MCP server + `ChannelSink.layerFromMcpServer` + the send
 * tool's `ChannelSend` bound to this session's peer) is assembled by the bin/cutover (#3062,
 * out of scope here); this module lands the composition + the socket transport bindings it needs.
 */
import {createHash} from "node:crypto";
import {NodeSocket, NodeSocketServer} from "@effect/platform-node";
import {Effect, Layer, type Option} from "effect";
import {RpcClient, RpcSerialization, RpcServer} from "effect/unstable/rpc";
import {type ChannelSink, channelInboxLayer} from "../edge/index.ts";
import {
	Dialer,
	inboxHandlers,
	make as makePeer,
	type Peer,
	PeerInbox,
	PeerUnreachableError,
	type RolePresence,
} from "../peer/index.ts";
import {RoleUniquenessError} from "./errors.ts";
import type {CrewRole} from "./roles.ts";
import {type ClaimReply, CrewTracker} from "./tracker.ts";

export interface CrewChannelConfig {
	readonly role: CrewRole;
	/** This session's dialable inbox address; the crew binds peer-id ≡ inbox-address. */
	readonly address: string;
}

export interface CrewChannel {
	readonly role: CrewRole;
	readonly address: string;
	/** The composed peer: its inbox (`received`) + its direct peer-to-peer `send`. */
	readonly peer: Peer;
	/** Role discovery: the live holder of `role` across the flat topology, or `None`. */
	readonly discover: (role: CrewRole) => Effect.Effect<Option.Option<RolePresence>>;
	/** A claim/collision-check on a resource (e.g. an issue) — the typed granted/collision reply. */
	readonly claim: (resource: string) => Effect.Effect<ClaimReply>;
}

/**
 * Stand up a crew channel for one role: acquire the role-uniqueness lease, then compose the
 * peer (which announces its presence for the connection lifetime). Requires the substrate
 * seams — `CrewTracker`, the peer `Tracker`/`Inbox`/`Dialer` ports — in context.
 *
 * The role-uniqueness lease is the one crew-specific rule the generic peer does not enforce:
 * a session claims its ROLE and is REJECTED (not co-occupied) when a different live session
 * already holds it. A resource collision is a value; a role collision is a rejection — that
 * asymmetry is the whole point of the lease (see `./errors.ts`).
 */
export const makeCrewChannel = Effect.fn("crew.makeCrewChannel")(function* (
	config: CrewChannelConfig,
) {
	const tracker = yield* CrewTracker;
	const lease = yield* tracker.claim({
		resource: config.role,
		claimant: config.address,
		role: config.role,
	});
	if (lease.collision) {
		return yield* new RoleUniquenessError({role: config.role, heldBy: lease.owner});
	}
	const peer = yield* makePeer({
		self: config.address,
		role: config.role,
		address: config.address,
	});
	return {
		role: config.role,
		address: config.address,
		peer,
		discover: (role: CrewRole) => tracker.lookup(role),
		claim: (resource: string) =>
			tracker.claim({resource, claimant: config.address, role: config.role}),
	} satisfies CrewChannel;
});

/** A per-address unix socket path for a peer inbox — deterministic, collision-free, short. */
export const inboxSocketPathFor = (address: string): string => {
	const digest = createHash("sha256").update(address).digest("hex").slice(0, 16);
	return `/tmp/kampus-crew-inbox-${digest}.sock`;
};

/**
 * The real socket `Dialer`: dial a target peer's inbox socket, `Deliver`, ack — all inside one
 * scope so the connection lives across the delivery, then closes. Every unreachable path (bad
 * socket, decode error) collapses to `PeerUnreachableError`, never a silent drop (#3035).
 */
export const crewSocketDialerLayer: Layer.Layer<Dialer> = Layer.succeed(Dialer, {
	send: (address, envelope) =>
		Effect.scoped(
			RpcClient.make(PeerInbox).pipe(
				Effect.flatMap((client) => client.Deliver(envelope)),
				Effect.provide(
					RpcClient.layerProtocolSocket().pipe(
						Layer.provide([
							NodeSocket.layerNet({path: inboxSocketPathFor(address)}),
							RpcSerialization.layerNdjson,
						]),
					),
				),
			),
		).pipe(
			Effect.mapError(
				(cause) => new PeerUnreachableError({target: address, reason: String(cause)}),
			),
		),
});

/**
 * The peer-inbox `RpcServer` over a unix socket at `address`, serving `PeerInbox` with the
 * channel-bridging inbox (`edge`) so each delivery wakes the session — mirrors the tracker's
 * socket server. Requires a `ChannelSink` (the edge's last-mile wake port).
 */
export const inboxServerSocketLayer = (address: string): Layer.Layer<never, unknown, ChannelSink> =>
	RpcServer.layer(PeerInbox).pipe(
		Layer.provide(inboxHandlers.pipe(Layer.provide(channelInboxLayer(address)))),
		Layer.provide(
			RpcServer.layerProtocolSocketServer.pipe(
				Layer.provide([
					RpcSerialization.layerNdjson,
					NodeSocketServer.layer({path: inboxSocketPathFor(address)}),
				]),
			),
		),
	);
