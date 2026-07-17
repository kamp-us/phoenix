/**
 * crew/session — THE runnable stdio entry the cutover binds (#3062): stand up one live crew
 * session's `McpServer` over stdio + its channel peer, so every inter-session seam that used to
 * ride the tmux relay convention (claim/collision-check, planned-epic handoff, drain tally,
 * intake pings, role discovery/presence, the role-uniqueness lease) now runs over the channels
 * protocol instead of buffer-paste + staggered-submit + pane-title discovery + capture-pane
 * identity verification.
 *
 * #3059 built the composition (`makeCrewChannel`) but deliberately left this live entry out; this
 * module binds it. The ONE running stdio `McpServer` drives BOTH edges of the channel:
 *   - outbound — the `channel_send` toolkit, its `ChannelSend` port bound to THIS session's peer,
 *     so a role addresses a peer by role (never a tmux window/pane) and the send dials it directly,
 *   - inbound  — the peer-inbox socket server whose deliveries wake the session through
 *     `ChannelSink.layerFromMcpServer` (the same running server), rendered as a `<channel>` tag.
 * Both edges share one `McpServer` instance by layer memoization (the shared `server` value), so
 * the toolkit registers on, and the sink wakes through, the exact transport serving stdio — the
 * same memoization the edge server (#3162) relies on when it provides `layerStdio` to the toolkit.
 *
 * The role-uniqueness lease + presence announce ride the peer's scope (`makeCrewChannel`): a
 * second live session for a held role fails the build with `RoleUniquenessError`, and presence
 * frees on teardown (connection-is-lease, #3035). The address is keyed on the role because the
 * lease guarantees one live session per role, so discovery→dial is deterministic.
 *
 * The binding is transport-injected: `channelSendFromPeer` takes the peer substrate as a
 * requirement (production supplies `peerSocketSubstrate` over unix sockets), so `session.test.ts`
 * drives the exact `ChannelSend`-from-peer binding fully in-memory (an `RpcTest` `CrewTracker` + an
 * in-memory `Connect`) — the same transport-free idiom `channel-server.test.ts` uses. The one seam
 * not exercised without a live MCP client is the stdio `McpServer` wake itself.
 */
import {NodeStdio} from "@effect/platform-node";
import {Effect, Layer} from "effect";
import {McpServer} from "effect/unstable/ai";
import {
	ChannelSend,
	ChannelSink,
	ChannelToolkit,
	channelExperimentalCapability,
	channelToolHandlers,
} from "../edge/index.ts";
import {type Dialer, Inbox, type Tracker} from "../peer/index.ts";
import {socketPathFor} from "../tracker/index.ts";
import {VERSION} from "../version.ts";
import {
	crewSocketDialerLayer,
	inboxServerSocketLayer,
	inboxSocketPathFor,
	makeCrewChannel,
} from "./channel-server.ts";
import type {RoleUniquenessError} from "./errors.ts";
import {crewHeartbeatLayer} from "./heartbeat.ts";
import type {CrewRole} from "./roles.ts";
import {type CrewTracker, crewTrackerHostOrDialLayer, peerTrackerLayer} from "./tracker.ts";

/** The MCP server identity a crew session advertises over stdio when none is configured. */
export const SESSION_SERVER_NAME = "@kampus/pipeline-crew-mcp" as const;

export interface CrewSessionConfig {
	readonly role: CrewRole;
	/** The project root whose per-project tracker socket this session rendezvous on. */
	readonly projectRoot: string;
	/** The MCP server name advertised over stdio (defaults to the package name). */
	readonly name?: string;
	/** The MCP server version advertised over stdio (defaults to the package `VERSION`). */
	readonly version?: string;
}

/**
 * This session's dialable inbox address. The crew binds peer-id ≡ inbox-address, and the
 * role-uniqueness lease guarantees one live session per role, so keying the address on the role
 * makes discovery→dial deterministic: any peer that discovers `role` dials this exact address
 * (`inboxSocketPathFor` maps it to the unix socket the inbound server binds).
 */
export const inboxAddressFor = (role: CrewRole): string => `inbox://${role}`;

/** The unix socket this session's peer inbox is served on — the address resolved to a socket path. */
export const inboxSocketFor = (role: CrewRole): string => inboxSocketPathFor(inboxAddressFor(role));

/**
 * The peer substrate over real unix sockets: the first-peer-spawn `CrewTracker` (host the tracker
 * if the project socket is free, else dial the peer already hosting it), the peer `Tracker` port
 * derived from it (one shared tracker client), this peer's local inbox log, and the socket dialer.
 * The production substrate `channelSendFromPeer` runs on; the tests inject an in-memory one
 * (an `RpcTest` `CrewTracker` + an in-memory `Dialer`) to drive the same binding transport-free.
 *
 * Hosting the tracker here (`crewTrackerHostOrDialLayer`) is what makes a session self-sufficient:
 * the first session for a project stands the tracker up, later sessions dial it, so a crew no longer
 * fails at startup on an unserved socket.
 */
export const peerSocketSubstrate = (
	config: CrewSessionConfig,
): Layer.Layer<CrewTracker | Tracker | Inbox | Dialer, unknown> => {
	const crewTracker = crewTrackerHostOrDialLayer(socketPathFor(config.projectRoot));
	return Layer.mergeAll(
		peerTrackerLayer.pipe(Layer.provideMerge(crewTracker)),
		Inbox.layer(inboxAddressFor(config.role)),
		crewSocketDialerLayer,
	);
};

/**
 * The outbound binding: `ChannelSend` resolved to THIS session's peer `send` (`makeCrewChannel`).
 * Building the layer acquires the role-uniqueness lease and announces presence for the layer's
 * scope; a second live session for a held role fails the build with `RoleUniquenessError`. This is
 * the exact `ChannelSend` the `channel_send` MCP tool routes through — the tests drive it directly.
 *
 * The peer substrate (`CrewTracker` + the peer ports) is a REQUIREMENT, not baked in, so the binding
 * is transport-injected: production supplies `peerSocketSubstrate`, the tests an in-memory substrate.
 */
export const channelSendFromPeer = (
	role: CrewRole,
): Layer.Layer<ChannelSend, RoleUniquenessError, CrewTracker | Tracker | Inbox | Dialer> =>
	Layer.effect(
		ChannelSend,
		Effect.gen(function* () {
			const channel = yield* makeCrewChannel({role, address: inboxAddressFor(role)});
			return {send: channel.peer.send};
		}),
	);

/**
 * The full runnable session layer: launch it (`Layer.launch`) to run one live crew session. The
 * one stdio `McpServer` (`server`) is provided to BOTH edges — the toolkit registers on it, the
 * inbound socket server's `ChannelSink` wakes through it — memoized to a single running transport.
 */
export const crewSessionLayer = (config: CrewSessionConfig) => {
	const address = inboxAddressFor(config.role);
	// The one running stdio McpServer + its channel capability; shared across both channel edges.
	const server = McpServer.layerStdio({
		name: config.name ?? SESSION_SERVER_NAME,
		version: config.version ?? VERSION,
		experimental: channelExperimentalCapability,
	}).pipe(Layer.provide(NodeStdio.layer));

	// The peer substrate, built once and SHARED (by memoization) between the outbound binding and the
	// heartbeat loop, so both drive the one hosted tracker / registry this session announces on.
	const substrate = peerSocketSubstrate(config);

	// outbound: the channel_send toolkit, its ChannelSend bound to this session's peer.
	const outbound = McpServer.toolkit(ChannelToolkit).pipe(
		Layer.provide(channelToolHandlers),
		Layer.provide(channelSendFromPeer(config.role).pipe(Layer.provide(substrate))),
		Layer.provide(server),
	);

	// keepalive: refresh this session's presence + role lease under the TTL so it never ages out while
	// the session is live (#3218). Shares `substrate`, so the beats reach the registry announced on.
	const heartbeat = crewHeartbeatLayer(address).pipe(Layer.provide(substrate));

	// inbound: the peer-inbox socket server, its deliveries waking THIS running server.
	const inbound = inboxServerSocketLayer(address).pipe(
		Layer.provide(ChannelSink.layerFromMcpServer),
		Layer.provide(server),
	);

	return Layer.mergeAll(outbound, heartbeat, inbound);
};

/**
 * Run one live crew session until interrupted — the stdio MCP entry the bin's `session` subcommand
 * drives. Blocks on `Layer.launch` (the stdio server + inbox socket server run on scoped fibers,
 * the role lease + presence held for the process lifetime); teardown frees the lease.
 */
export const runCrewSession = (config: CrewSessionConfig) => Layer.launch(crewSessionLayer(config));
