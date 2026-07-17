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
import {Context, Effect, Layer, Option, type Scope} from "effect";
import {RpcClient, RpcSerialization} from "effect/unstable/rpc";
import {type RolePresence, Tracker} from "../peer/index.ts";
import type * as Schema from "../protocol/schema.ts";
import {isTrackerAddressInUse, TrackerRegistry, trackerServerLayer} from "../tracker/index.ts";

/** The typed answer to a claim/collision-check — re-exported so consumers name one type. */
export type ClaimReply = typeof Schema.ClaimReply.Type;
type ClaimRequest = typeof Schema.ClaimRequest.Type;
type PresenceAnnouncement = typeof Schema.PresenceAnnouncement.Type;
type RoleLookupQuery = typeof Schema.RoleLookupQuery.Type;
type RoleLookupResult = typeof Schema.RoleLookupResult.Type;

/**
 * The structural shape of the registry client the crew depends on — the three registry
 * kinds it drives. Any `RpcClient(TrackerRegistry)` satisfies it (the real socket client,
 * or an in-memory `RpcTest` client in tests); the error channel is `unknown` because it is
 * `orDie`'d at the seam.
 */
export interface TrackerRegistryClient {
	readonly Claim: (payload: ClaimRequest) => Effect.Effect<ClaimReply, unknown>;
	readonly AnnouncePresence: (payload: PresenceAnnouncement) => Effect.Effect<void, unknown>;
	readonly LookupRole: (payload: RoleLookupQuery) => Effect.Effect<RoleLookupResult, unknown>;
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
		/** Soft presence announce, held for the enclosing scope (connection-is-lease). */
		readonly announce: (presence: RolePresence) => Effect.Effect<void, never, Scope.Scope>;
		/** The live holder of `role`, or `None` when absent/expired — the explicit not-present result. */
		readonly lookup: (role: string) => Effect.Effect<Option.Option<RolePresence>>;
	}
>()("@kampus/pipeline-crew-mcp/crew/CrewTracker") {
	/** Build the service from a live registry client (real socket or in-memory `RpcTest`). */
	static readonly fromClient = (client: TrackerRegistryClient): Layer.Layer<CrewTracker> =>
		Layer.succeed(CrewTracker, {
			claim: ({resource, claimant, role}) =>
				client.Claim({resource, claimant, role, at: now()}).pipe(Effect.orDie),
			announce: (presence) =>
				Effect.acquireRelease(
					// peer-id ≡ inbox-address: announce the dialable address so a lookup can dial it back.
					client
						.AnnouncePresence({peer: presence.address, role: presence.role, at: now()})
						.pipe(Effect.orDie),
					// The release rides the socket lifecycle (a dropped connection ages/frees the lease);
					// there is no wire release kind, so scope close is a no-op on the client side.
					() => Effect.void,
				),
			lookup: (role) =>
				client.LookupRole({role}).pipe(
					Effect.orDie,
					Effect.map((result) => {
						const first = result.peers[0];
						return first
							? Option.some<RolePresence>({role: first.role, peer: first.peer, address: first.peer})
							: Option.none<RolePresence>();
					}),
				),
		});
}

/** The generic `peer/Tracker` port, derived from `CrewTracker` — what `Peer.make` consumes. */
export const peerTrackerLayer: Layer.Layer<Tracker, never, CrewTracker> = Layer.effect(
	Tracker,
	Effect.gen(function* () {
		const tracker = yield* CrewTracker;
		return {announce: tracker.announce, lookup: tracker.lookup};
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
export const crewTrackerHostOrDialLayer = (socketPath: string): Layer.Layer<CrewTracker, unknown> =>
	crewTrackerSocketLayer(socketPath).pipe(
		Layer.provide(trackerServerLayer(socketPath)),
		Layer.catchCause((cause) =>
			isTrackerAddressInUse(cause)
				? crewTrackerSocketLayer(socketPath)
				: Layer.effect(CrewTracker, Effect.failCause(cause)),
		),
	);
