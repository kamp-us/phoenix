/**
 * crew/tracker — the crew's live tracker seam: the `CrewTracker` service that speaks the
 * control-plane registry (`../tracker/`) over an `RpcClient(TrackerRegistry)`, and the
 * `peerTrackerLayer` that derives the generic `peer/Tracker` port from it so `Peer.make`
 * can announce + look up without knowing the transport.
 *
 * Two design choices worth stating once:
 *   - A tracker transport failure is unrecoverable for a session, so the registry client's
 *     transport errors are collapsed with `Effect.orDie` — the service's own error channel
 *     stays clean (only a resource collision, which is a VALUE in `ClaimReply`, crosses it).
 *   - The crew binds peer-id ≡ inbox-address: the registry stores one `peer` field per
 *     presence, so the announced `peer` IS the dialable inbox address, and a lookup recovers
 *     that address back out (matching the `inbox://…` convention the tracker socket test uses).
 */
import {NodeSocket} from "@effect/platform-node";
import {Array as Arr, Context, Effect, type FileSystem, Layer, type Scope} from "effect";
import {RpcClient, RpcSerialization} from "effect/unstable/rpc";
import {type RolePresence, Tracker} from "../peer/index.ts";
import type * as Schema from "../protocol/schema.ts";
import {isTrackerAddressInUse, TrackerRegistry, trackerServerLayer} from "../tracker/index.ts";

/** The typed answer to a claim/collision-check — re-exported so consumers name one type. */
export type ClaimReply = typeof Schema.ClaimReply.Type;
type ClaimRequest = typeof Schema.ClaimRequest.Type;
type ReleaseClaim = typeof Schema.ReleaseClaim.Type;
type PresenceAnnouncement = typeof Schema.PresenceAnnouncement.Type;
type RoleLookupQuery = typeof Schema.RoleLookupQuery.Type;
type RoleLookupResult = typeof Schema.RoleLookupResult.Type;
type HeartbeatMessage = typeof Schema.Heartbeat.Type;

/**
 * The structural shape of the registry client the crew depends on — the five registry
 * kinds it drives. Any `RpcClient(TrackerRegistry)` satisfies it (the real socket client,
 * or an in-memory `RpcTest` client in tests); the error channel is `unknown` because it is
 * `orDie`'d at the seam.
 */
export interface TrackerRegistryClient {
	readonly Claim: (payload: ClaimRequest) => Effect.Effect<ClaimReply, unknown>;
	readonly Release: (payload: ReleaseClaim) => Effect.Effect<void, unknown>;
	readonly AnnouncePresence: (payload: PresenceAnnouncement) => Effect.Effect<void, unknown>;
	readonly LookupRole: (payload: RoleLookupQuery) => Effect.Effect<RoleLookupResult, unknown>;
	readonly Heartbeat: (payload: HeartbeatMessage) => Effect.Effect<void, unknown>;
}

const now = (): string => new Date().toISOString();

export class CrewTracker extends Context.Service<
	CrewTracker,
	{
		/** A named claim/collision-check: granted vs collision is a VALUE in the reply, never a failure. */
		readonly claim: (input: {
			readonly resource: string;
			readonly claimant: string;
			readonly role: string;
		}) => Effect.Effect<ClaimReply>;
		/**
		 * Claim `resource` for the enclosing scope: acquire on entry, and on scope close free the
		 * claim via `Release` iff it was granted — the lane-finish fast path (ADR 0191 facet 3). The
		 * reply's granted/collision is a VALUE, so a collision holds the scope open with nothing to
		 * free (release is holder-guarded + idempotent, so freeing a lost claim is a safe no-op).
		 */
		readonly acquireClaim: (input: {
			readonly resource: string;
			readonly claimant: string;
			readonly role: string;
		}) => Effect.Effect<ClaimReply, never, Scope.Scope>;
		/** Free a resource claim this session holds — the explicit lane-finish release (ADR 0191 facet 3). */
		readonly release: (input: {
			readonly resource: string;
			readonly claimant: string;
		}) => Effect.Effect<void>;
		/** Soft presence announce, held for the enclosing scope (connection-is-lease). */
		readonly announce: (presence: RolePresence) => Effect.Effect<void, never, Scope.Scope>;
		/**
		 * Refresh this session's presence + role lease before it ages out. Presence-only: the sender
		 * sends one `Heartbeat {peer, ttlSeconds}` and never touches a resource claim (#3228). Driven
		 * on an interval under the TTL by `crew/heartbeat.ts`.
		 */
		readonly heartbeat: (input: {
			readonly peer: string;
			readonly ttlSeconds: number;
		}) => Effect.Effect<void>;
		/**
		 * The live holders of `role` — every present instance (`[]` ⇒ absent/expired). A bridge
		 * resolves to its single holder; an engine to its whole live pool, so a sender can address one
		 * chosen instance or fan across all of them (the wire's `RoleLookupResult.peers` is an array).
		 */
		readonly lookup: (role: string) => Effect.Effect<ReadonlyArray<RolePresence>>;
	}
>()("@kampus/pipeline-crew-mcp/crew/CrewTracker") {
	/** Build the service from a live registry client (real socket or in-memory `RpcTest`). */
	static readonly fromClient = (client: TrackerRegistryClient): Layer.Layer<CrewTracker> =>
		Layer.succeed(CrewTracker, {
			claim: ({resource, claimant, role}) =>
				client.Claim({resource, claimant, role, at: now()}).pipe(Effect.orDie),
			acquireClaim: ({resource, claimant, role}) =>
				Effect.acquireRelease(
					client.Claim({resource, claimant, role, at: now()}).pipe(Effect.orDie),
					// Free on scope close, but only a claim we actually won — release is holder-guarded, so
					// releasing a collided (un-held) claim would no-op anyway; gating on `granted` keeps intent clear.
					(reply) =>
						reply.granted
							? client.Release({resource, claimant, at: now()}).pipe(Effect.orDie)
							: Effect.void,
				),
			release: ({resource, claimant}) =>
				client.Release({resource, claimant, at: now()}).pipe(Effect.orDie),
			announce: (presence) =>
				Effect.acquireRelease(
					// peer-id ≡ inbox-address: announce the dialable address so a lookup can dial it back.
					client
						.AnnouncePresence({peer: presence.address, role: presence.role, at: now()})
						.pipe(Effect.orDie),
					// No wire release kind exists, so scope close is a client-side no-op. A live session
					// keeps its lease via the heartbeat loop (crew/heartbeat.ts) refreshing it under
					// DEFAULT_TTL_SECONDS; a dropped session's lease frees by TTL-aging once the beats
					// stop — the tracker has no disconnect hook.
					() => Effect.void,
				),
			heartbeat: ({peer, ttlSeconds}) =>
				client.Heartbeat({peer, ttlSeconds, at: now()}).pipe(Effect.orDie),
			// peer-id ≡ inbox-address: each present peer IS its own dialable address, so a lookup
			// recovers the full live set of addresses (one per bridge, N across an engine pool).
			lookup: (role) =>
				client.LookupRole({role}).pipe(
					Effect.orDie,
					Effect.map((result) =>
						result.peers.map(
							(entry): RolePresence => ({role: entry.role, peer: entry.peer, address: entry.peer}),
						),
					),
				),
		});
}

/**
 * The generic `peer/Tracker` port, derived from `CrewTracker` — what `Peer.make` consumes. The
 * peer port resolves ONE live holder to dial (`peer.send` addresses a role, not an instance), so
 * it takes the head of `CrewTracker`'s live set: a bridge's single holder, or any one instance of
 * an engine pool. Fanning across the pool is the crew-facing `discover`'s job, not this port's.
 */
export const peerTrackerLayer: Layer.Layer<Tracker, never, CrewTracker> = Layer.effect(
	Tracker,
	Effect.gen(function* () {
		const tracker = yield* CrewTracker;
		return {
			announce: tracker.announce,
			lookup: (role) => tracker.lookup(role).pipe(Effect.map(Arr.head)),
		};
	}),
);

/** The registry client's socket protocol for `socketPath` — the per-project tracker rendezvous. */
const trackerClientSocketProtocol = (socketPath: string) =>
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide([NodeSocket.layerNet({path: socketPath}), RpcSerialization.layerNdjson]),
	);

/**
 * A socket-backed `CrewTracker` for the tracker at `socketPath` — the production binding a
 * runnable crew session uses (the in-memory tests supply `CrewTracker.fromClient` with an
 * `RpcTest` client instead).
 */
export const crewTrackerSocketLayer = (socketPath: string) =>
	Layer.unwrap(RpcClient.make(TrackerRegistry).pipe(Effect.map(CrewTracker.fromClient))).pipe(
		Layer.provide(trackerClientSocketProtocol(socketPath)),
	);

/**
 * The first-peer-spawn `CrewTracker` binding a runnable session uses: host the tracker for this
 * project if the socket is free, otherwise dial the peer that already hosts it. The first bind wins
 * the socket; a racing peer's bind raises `EADDRINUSE`, caught here so it dials the existing tracker
 * instead of crashing — the exact story `../tracker/server.ts` documents, now wired. Two concurrent
 * sessions on one project root thus resolve to exactly one live tracker.
 *
 * `Layer.provide` sequences the bind before the dial (the server layer is built first, so the socket
 * is listening before the client connects) and keeps the hosted server scoped for the session's
 * lifetime. A non-`EADDRINUSE` bind failure is re-raised, never dialed over.
 */
export const crewTrackerHostOrDialLayer = (
	socketPath: string,
): Layer.Layer<CrewTracker, unknown, FileSystem.FileSystem> =>
	crewTrackerSocketLayer(socketPath).pipe(
		Layer.provide(trackerServerLayer(socketPath)),
		Layer.catchCause((cause) =>
			isTrackerAddressInUse(cause)
				? crewTrackerSocketLayer(socketPath)
				: Layer.effect(CrewTracker, Effect.failCause(cause)),
		),
	);
