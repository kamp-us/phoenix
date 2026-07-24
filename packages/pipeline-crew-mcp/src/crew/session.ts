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
 * Both edges MUST land on ONE `McpServer` instance: the toolkit registers its tools on it and the
 * sink wakes through it. `assembleCrewSession` achieves that AND wins the two build-order races that
 * otherwise leave the served session advertising no tools (`/mcp` Capabilities: none, `channel_send`
 * absent) — the #3479 assembly defect. See `assembleCrewSession` for the mechanism (merge the
 * registrations + provide the transport once; claim the peer FIRST so `ChannelSend` is an instant
 * binding when the toolkit registers) and `.patterns/mcp-server-effect.md` for the Effect idiom.
 *
 * The per-kind cardinality lease + presence announce ride the peer's scope (`makeCrewChannel`): a
 * second live session for a held BRIDGE role fails the build with `RoleUniquenessError`, an ENGINE
 * role admits N instances, and presence frees on teardown (connection-is-lease, #3035). A bridge's
 * address is its role (`inbox://<role>`) — its singleton lease keeps discover→dial deterministic;
 * an engine's is per-instance (`inbox://<role>/<instance>`) so its pool never collapses. See
 * `inboxAddressFor` (ADR 0189).
 *
 * The binding is transport-injected: `channelSendFromPeer` takes the peer substrate as a
 * requirement (production supplies `peerSocketSubstrate` over unix sockets), so `session.test.ts`
 * drives the exact `ChannelSend`-from-peer binding fully in-memory (an `RpcTest` `CrewTracker` + an
 * in-memory `Connect`) — the same transport-free idiom `channel-server.test.ts` uses. A fake `Stdio`
 * additionally drives the forked stdio run-loop's serve ordering (the Race-2 guard in
 * `assembleCrewSession`); the one seam still not exercised is a full live-client stdio wake round-trip.
 */
import {randomUUID} from "node:crypto";
import {NodeStdio} from "@effect/platform-node";
import {Effect, type FileSystem, Layer} from "effect";
import {type McpSchema, McpServer} from "effect/unstable/ai";
import {
	assertToolSchemas,
	ChannelClaim,
	ChannelDescribe,
	ChannelRelease,
	ChannelSend,
	ChannelSink,
	ChannelToolkit,
	ClaimToolkit,
	channelExperimentalCapability,
	channelToolHandlers,
	claimToolHandlers,
	KindsToolkit,
	kindsToolHandlers,
	ReleaseToolkit,
	releaseToolHandlers,
} from "../edge/index.ts";
import {type Dialer, Inbox, type Tracker} from "../peer/index.ts";
import {resolveRendezvous} from "../tracker/index.ts";
import {VERSION} from "../version.ts";
import {
	crewSocketDialerLayer,
	inboxServerSocketLayer,
	inboxSocketPathFor,
	makeCrewChannel,
} from "./channel-server.ts";
import {resolveChannelContract} from "./contract.ts";
import type {RoleUniquenessError} from "./errors.ts";
import {crewHeartbeatLayer} from "./heartbeat.ts";
import {type CrewRole, kindOf} from "./roles.ts";
import {type CrewTracker, crewTrackerHostOrDialLayer, peerTrackerLayer} from "./tracker.ts";

/** The MCP server identity a crew session advertises over stdio when none is configured. */
export const SESSION_SERVER_NAME = "@kampus/pipeline-crew-mcp" as const;

export interface CrewSessionConfig {
	readonly role: CrewRole;
	/** Seeds git repo discovery; the session meets at that repo's canonical rendezvous (ADR 0197). */
	readonly projectRoot: string;
	/** The MCP server name advertised over stdio (defaults to the package name). */
	readonly name?: string;
	/** The MCP server version advertised over stdio (defaults to the package `VERSION`). */
	readonly version?: string;
	/**
	 * The launcher-assigned per-instance identity (#3297) an engine session binds, threaded from the
	 * `session --instance <id>` flag (bin.ts) that standup/bind.ts bakes for engine roles. Exact-optional
	 * (like `name`/`version`): present ⇒ the session comes up on THAT address; absent (a bridge/singleton,
	 * or a direct run) ⇒ `sessionInstance` mints one. See `sessionInstance` (#3445).
	 */
	readonly instance?: string;
}

/**
 * This session's dialable inbox address, keyed by the role's KIND (ADR 0189). A BRIDGE keeps the
 * deterministic singleton `inbox://<role>`: its cardinality-1 lease guarantees one live session, so
 * discover→dial stays deterministic without an instance. An ENGINE carries a per-instance
 * discriminator `inbox://<role>/<instance>`, so N engine sessions hold N distinct presence leases
 * (keyed by peer in the registry) and resolve to N distinct inbox sockets — never overwriting each
 * other. `inboxSocketPathFor` hashes the whole address, so two engine instances get collision-free
 * sockets. The `instance` is a per-session id, resolved once in `crewSessionLayer` (`sessionInstance`).
 */
export const inboxAddressFor = (role: CrewRole, instance: string): string =>
	kindOf(role) === "engine" ? `inbox://${role}/${instance}` : `inbox://${role}`;

/** The unix socket this session's peer inbox is served on — the address resolved to a socket path. */
export const inboxSocketFor = (role: CrewRole, instance: string): string =>
	inboxSocketPathFor(inboxAddressFor(role, instance));

/**
 * This session's per-instance id: the launcher-assigned `config.instance` when present (an engine
 * bound by standup/bind.ts's `--instance`, #3297), else a freshly minted UUID. The fallback preserves
 * the pre-#3445 behavior for the no-instance case — a bridge singleton, which folds no instance into
 * its address anyway, or a direct `session` run — so honoring the launcher's identity never regresses
 * the absent case. See `inboxAddressFor` for how the id enters the address.
 */
export const sessionInstance = (config: CrewSessionConfig): string =>
	config.instance ?? randomUUID();

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
	address: string,
): Layer.Layer<CrewTracker | Tracker | Inbox | Dialer, unknown, FileSystem.FileSystem> => {
	const crewTracker = Layer.unwrap(
		resolveRendezvous(config.projectRoot).pipe(
			Effect.map((rendezvous) => crewTrackerHostOrDialLayer(rendezvous.socketPath)),
		),
	);
	return Layer.mergeAll(
		peerTrackerLayer.pipe(Layer.provideMerge(crewTracker)),
		Inbox.layer(address),
		crewSocketDialerLayer,
	);
};

/**
 * The outbound binding as a standalone layer: `ChannelSend` resolved to THIS session's peer `send`
 * (`makeCrewChannel`), acquiring the role-uniqueness lease + presence for the layer's scope (a held
 * role fails the build with `RoleUniquenessError`). It yields the SAME `{send: channel.peer.send}`
 * binding `assembleCrewSession` hoists inline — but as an ASYNC `Layer.effect`, so it is NOT used in
 * the live assembly (that path resolves the peer first, then binds `ChannelSend` instantly, to win
 * Race 2 above). `session.test.ts` drives THIS form directly to prove the send round-trips end to end.
 *
 * The peer substrate (`CrewTracker` + the peer ports) is a REQUIREMENT, not baked in, so the binding
 * is transport-injected: production supplies `peerSocketSubstrate`, the tests an in-memory substrate.
 */
export const channelSendFromPeer = (
	role: CrewRole,
	address: string,
): Layer.Layer<ChannelSend, RoleUniquenessError, CrewTracker | Tracker | Inbox | Dialer> =>
	Layer.effect(
		ChannelSend,
		Effect.gen(function* () {
			const channel = yield* makeCrewChannel({role, address});
			return {send: channel.peer.send};
		}),
	);

/**
 * The two registrations that MUST land on the ONE served `McpServer` — outbound (the `channel_send`
 * toolkit) and inbound (the inbox-socket server whose `ChannelSink` wakes through the server) —
 * merged and provided their `transport` exactly ONCE. This is the load-bearing composition (#3479),
 * and it must win TWO races or the live session advertises no tools (`/mcp` Capabilities: none).
 *
 * Race 1 — the single instance (fixed #3480). `McpServer.toolkit` INTERNALLY self-provides its own
 * `McpServer.layer` (`toolkit = effectDiscard(registerToolkit(x)).pipe(Layer.provide(McpServer.layer))`),
 * so providing the transport *per registration* would leave the toolkit registering into a throwaway
 * instance while the run loop serves a different one with `server.tools === []`. Merging the
 * registrations and providing the transport ONCE lets `McpServer.layer` memoize to a single instance
 * across the toolkit registration, the inbound sink, and the run loop.
 *
 * Race 2 — claim BEFORE serve (the live #3479 defect this build fixes). `McpServer.layerStdio` forks
 * its serve/run-loop at layer-BUILD time and begins answering the client's `initialize` immediately;
 * Effect's initialize handler sets `capabilities.tools` only `if (server.tools.length > 0)` AT THAT
 * MOMENT, and a client that sees no `tools` capability never calls `tools/list` again. If the toolkit
 * registration is still awaiting an async `ChannelSend` — the peer's tracker-`claim()` over a unix
 * socket — when the run-loop answers `initialize`, `server.tools` is empty and `channel_send` is lost
 * for the session's life. The fix runs `makeCrewChannel` (the claim + presence handshake) FIRST via
 * `Layer.unwrap`, so `ChannelSend` is an instant `Layer.succeed` with the peer already resolved: the
 * toolkit registers with no async gap, and by the time the forked run-loop serves `initialize` the
 * tool is already on `server.tools`. `RoleUniquenessError` still fails the build fail-closed — the
 * claim is on the critical path of the layer, so a held role slot aborts assembly before it serves.
 *
 * Transport-injected on purpose: production supplies the stdio transport, `session.test.ts` supplies
 * an in-process `McpServer.layerHttp` (advertised tools + capabilities) and a fake-`Stdio` forked
 * run-loop (the async-`ChannelSend` race guard), both without a live stdio client.
 */
export const assembleCrewSession = <RIn, RSub = never>(
	config: CrewSessionConfig,
	address: string,
	// The substrate may carry its own requirement (`RSub`): production's `peerSocketSubstrate` needs
	// `FileSystem` (the tracker's stale-socket reclaim seam), discharged with `RIn` at the bin's
	// NodeServices.layer; the in-memory test substrate is `RSub = never`.
	substrate: Layer.Layer<CrewTracker | Tracker | Inbox | Dialer, unknown, RSub>,
	transport: Layer.Layer<McpServer.McpServer | McpSchema.McpServerClient, never, RIn>,
	// `FileSystem` is a standing requirement independent of the substrate: the inbound socket server
	// (`inboxServerSocketLayer`) reclaims a stale inbox socket through the `FileSystem` seam (#3489),
	// discharged with `RIn`/`RSub` at the bin's `NodeServices.layer` — production's `peerSocketSubstrate`
	// already carries it in `RSub`, so this widens nothing for the live path.
): Layer.Layer<never, unknown, RIn | RSub | FileSystem.FileSystem> =>
	// Claim FIRST (Race 2): the slow tracker-claim/presence handshake runs in the unwrap's effect,
	// BEFORE the run-loop-forking transport is built, so ChannelSend below is a zero-async binding.
	Layer.unwrap(
		Effect.gen(function* () {
			// Startup invariant (#3753): every tool this session will register must generate a spec-valid
			// top-level `{"type":"object"}` inputSchema. A client rejects the WHOLE tools/list response on
			// one bad schema, so the failure mode without this fence is a silently tool-less session.
			yield* assertToolSchemas([ChannelToolkit, ClaimToolkit, ReleaseToolkit, KindsToolkit]);
			const channel = yield* makeCrewChannel({role: config.role, address});
			// Startup invariant (#3622): resolve the full discoverable channel contract BEFORE serving.
			// A shared kind set that can't be fully resolved to a shape fails the build HERE (on the boot
			// critical path, like the claim), so a peer never discovers a gap at first send.
			const contract = yield* resolveChannelContract();
			// outbound: the channel_send toolkit, its ChannelSend an INSTANT bind to the already-resolved
			// peer — the toolkit registers with no socket await in its build path (Race 2).
			const outbound = McpServer.toolkit(ChannelToolkit).pipe(
				Layer.provide(channelToolHandlers),
				Layer.provide(Layer.succeed(ChannelSend, {send: channel.peer.send})),
			);
			// deconfliction: the channel_claim toolkit (#3509), its ChannelClaim an INSTANT bind to the
			// already-resolved channel's tracker claim — same zero-async binding as `outbound` (Race 2).
			const claim = McpServer.toolkit(ClaimToolkit).pipe(
				Layer.provide(claimToolHandlers),
				Layer.provide(Layer.succeed(ChannelClaim, {claim: channel.claim})),
			);
			// release: the channel_release toolkit (#3796 facet 2), the claim's counterpart — its
			// ChannelRelease an INSTANT bind to the already-resolved channel's tracker release (Race 2).
			const release = McpServer.toolkit(ReleaseToolkit).pipe(
				Layer.provide(releaseToolHandlers),
				Layer.provide(Layer.succeed(ChannelRelease, {release: channel.release})),
			);
			// discovery: the channel_kinds toolkit (#3622), its ChannelDescribe an INSTANT bind to the
			// contract resolved just above — a static value, so it never re-derives the catalog nor awaits.
			const kinds = McpServer.toolkit(KindsToolkit).pipe(
				Layer.provide(kindsToolHandlers),
				Layer.provide(Layer.succeed(ChannelDescribe, {view: contract})),
			);
			// inbound: the peer-inbox socket server, its deliveries waking THIS served server.
			const inbound = inboxServerSocketLayer(address).pipe(
				Layer.provide(ChannelSink.layerFromMcpServer),
			);
			// Provide the transport ONCE to the MERGED registrations — the single-instance memo (Race 1).
			return Layer.mergeAll(outbound, claim, release, kinds, inbound).pipe(
				Layer.provide(transport),
			);
		}),
	).pipe(Layer.provide(substrate));

/**
 * The full runnable session layer: launch it (`Layer.launch`) to run one live crew session. The one
 * stdio `McpServer` is provided to the merged registrations exactly once (`assembleCrewSession`), so
 * the served server advertises the `channel_send` + `channel_claim` + `channel_release` + `channel_kinds`
 * tools + the `claude/channel` capability; the heartbeat rides the same `substrate` the outbound binding announces on.
 */
export const crewSessionLayer = (config: CrewSessionConfig) => {
	// One per-session instance id, resolved once here and threaded to every address derivation, so an
	// engine session's inbox/announce/heartbeat all agree on the same per-instance address (a bridge
	// ignores it and keeps its singleton address). Honors the launcher-assigned `config.instance` when
	// present, minting one only when absent. See `sessionInstance` / `inboxAddressFor`.
	const address = inboxAddressFor(config.role, sessionInstance(config));
	// The one running stdio McpServer + its channel capability; the served transport for both edges.
	const server = McpServer.layerStdio({
		name: config.name ?? SESSION_SERVER_NAME,
		version: config.version ?? VERSION,
		experimental: channelExperimentalCapability,
	}).pipe(Layer.provide(NodeStdio.layer));

	// The peer substrate, built once and SHARED (by memoization) between the outbound binding and the
	// heartbeat loop, so both drive the one hosted tracker / registry this session announces on.
	const substrate = peerSocketSubstrate(config, address);

	// keepalive: refresh this session's presence + role lease under the TTL so it never ages out while
	// the session is live (#3218). Shares `substrate`, so the beats reach the registry announced on.
	const heartbeat = crewHeartbeatLayer(address).pipe(Layer.provide(substrate));

	return Layer.mergeAll(assembleCrewSession(config, address, substrate, server), heartbeat);
};

/**
 * Run one live crew session until interrupted — the stdio MCP entry the bin's `session` subcommand
 * drives. Blocks on `Layer.launch` (the stdio server + inbox socket server run on scoped fibers,
 * the role lease + presence held for the process lifetime); teardown frees the lease.
 */
export const runCrewSession = (config: CrewSessionConfig) => Layer.launch(crewSessionLayer(config));
