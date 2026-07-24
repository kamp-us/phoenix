/**
 * tracker/registry-core — the soft-state presence registry as a pure data structure.
 *
 * No Effect, no IO: state transitions only, so the announce / lookup / heartbeat-TTL /
 * presence and resource-claim semantics are unit-testable in isolation from the socket
 * transport. The service (`./registry.ts`) holds one of these in a `Ref` and supplies the clock.
 *
 * Two keyspaces that never share a map (ADR 0191): presence leases keyed by `peer`, and
 * resource claims keyed by `resource`. A presence lease and an issue claim are different
 * lifecycles — keeping them in distinct typed maps makes "a `lookup` returns a claim holder"
 * unrepresentable rather than checked after the fact.
 *
 * A lease is one of two phases — `reserve`d (bare) or `announce`d (attached) — so presence
 * reflects a live channel half, not a socket file or a bare lease (#3628):
 *   - A **bare** lease (`reserve`) holds the role slot and backs the crew cardinality claim
 *     (its liveness clock, ADR 0191 facet 2) + connection-is-lease — but is NOT discoverable.
 *   - An **attached** lease (`announce`) is a bare lease whose peer inbox is confirmed serving;
 *     only attached leases are returned by `lookup`. A session that reserves its slot but never
 *     attaches its inbox (channel-deaf) therefore never appears as a live peer.
 * `holderHasLivePresence` (claim liveness) counts a live lease of EITHER phase — the slot holds
 * from the reservation; `lookup` (discovery) counts only attached ones.
 *
 * The three non-obvious model choices:
 *   - Presence is keyed by `peer` (the connection identity), NOT by role — so N distinct peers
 *     serving one role coexist as N distinct leases (a role's engine pool), and `lookup(role)`
 *     returns the whole live set. Role uniqueness is NOT a presence concern: a bridge's
 *     singleton-ness is enforced upstream by the crew per-kind cardinality claim, never here
 *     (ADR 0189) — so the presence registry stays role-agnostic and never collapses a pool.
 *   - "Connection-is-lease" is modelled by the peer id being the connection identity, and liveness
 *     being measured against the tracker's own clock (never the client-supplied `at`): a peer that
 *     stops heart-beating ages past its TTL and its lease frees, and an explicit `release` (a
 *     graceful connection close) frees it immediately. A client can't extend its own liveness by
 *     lying about `at`.
 *   - A resource claim carries NO independent TTL — it is live exactly as long as its holder's
 *     presence is live (ADR 0191 facet 2). One liveness clock (presence); claims ride it. So a
 *     `heartbeat` refreshes leases only and never touches claims (facet 4 falls out by construction);
 *     a claim frees on explicit `releaseClaim` or is reaped once its holder has no live presence.
 */

/** The default presence TTL applied on announce, until the first `heartbeat` sets a real one. */
export const DEFAULT_TTL_SECONDS = 30;

/**
 * One presence lease: a peer, the role it serves, its soft-state liveness window, and whether its
 * inbox is attached and serving. `attached` is the live-channel-half bit (#3628): a bare reservation
 * holds the role slot (`attached: false`), an announce flips it on once the inbox serves. `lookup`
 * returns only attached leases; the cardinality claim's liveness clock counts either phase.
 */
export interface Lease {
	readonly role: string;
	readonly peer: string;
	readonly ttlSeconds: number;
	readonly lastSeenMillis: number;
	readonly attached: boolean;
}

/**
 * One resource claim: a deconfliction hold on a resource (an issue id) by a peer. Distinct from
 * `Lease` — a claim has no TTL of its own; its liveness derives from `holder`'s presence lease
 * (ADR 0191 facet 2). `claimantRole` records which role holds the claim so tooling can read it
 * without a schema change (`ClaimRequest`'s existing `role` field feeds it).
 */
export interface Claim {
	readonly resource: string;
	readonly holder: string;
	readonly claimantRole: string;
	readonly claimedAtMillis: number;
}

/** The whole registry: presence leases (keyed by peer) and resource claims (keyed by resource). */
export interface RegistryState {
	readonly leases: ReadonlyMap<string, Lease>;
	readonly claims: ReadonlyMap<string, Claim>;
}

/** A present peer for a role, as the pure core reports it (millis; the handler formats the ISO). */
export interface PresenceRecord {
	readonly peer: string;
	readonly role: string;
	readonly lastSeenMillis: number;
}

/**
 * The result of a resource claim: `Granted` when the caller now holds the resource, `Collision`
 * when a different peer with live presence already holds it (the claim is NOT stolen).
 */
export type ClaimOutcome =
	| {readonly _tag: "Granted"; readonly holder: string; readonly sinceMillis: number}
	| {readonly _tag: "Collision"; readonly holder: string; readonly sinceMillis: number};

/** A fresh, empty registry — both keyspaces empty. */
export const empty = (): RegistryState => ({leases: new Map(), claims: new Map()});

const isLive = (lease: Lease, nowMillis: number): boolean =>
	nowMillis <= lease.lastSeenMillis + lease.ttlSeconds * 1000;

/**
 * True iff `holder` holds a live presence lease of EITHER phase — the claim-liveness clock (ADR 0191
 * facet 2). Attachment is deliberately not required: the cardinality claim's slot holds from the
 * bare reservation on, so a role stays uniqueness-guarded before its inbox finishes attaching (#3628).
 */
const holderHasLivePresence = (
	leases: ReadonlyMap<string, Lease>,
	holder: string,
	nowMillis: number,
): boolean => {
	const lease = leases.get(holder);
	return lease !== undefined && isLive(lease, nowMillis);
};

type PresenceInput = {
	readonly role: string;
	readonly peer: string;
	readonly ttlSeconds: number;
	readonly nowMillis: number;
};

const putLease = (state: RegistryState, input: PresenceInput, attached: boolean): RegistryState => {
	const {role, peer, ttlSeconds, nowMillis} = input;
	const lease: Lease = {role, peer, ttlSeconds, lastSeenMillis: nowMillis, attached};
	const leases = new Map(state.leases);
	leases.set(peer, lease);
	return {...state, leases};
};

/**
 * Register `peer`'s presence for `role` as ATTACHED (its inbox is serving) — the discoverable phase:
 * upsert the lease with `attached: true`, bumping `lastSeen` to now. Keyed by `peer`, so a
 * re-announce refreshes the same lease and two distinct peers on one role coexist — presence never
 * rejects (role uniqueness is the crew cardinality claim's job, ADR 0189), it only records who is
 * live and serving. Callers announce ONLY once the inbox is attached, so a live channel half — not a
 * bare lease — is what `lookup` surfaces (#3628).
 */
export const announce = (state: RegistryState, input: PresenceInput): RegistryState =>
	putLease(state, input, true);

/**
 * Reserve `peer`'s role slot as a BARE lease (`attached: false`) — the not-yet-serving phase: it
 * holds the slot and backs the crew cardinality claim's liveness clock (ADR 0191 facet 2) +
 * connection-is-lease, but is NOT returned by `lookup`. This is the "presence reflects a socket file
 * or a bare lease" case the fix makes non-discoverable (#3628): a session reserves on construction,
 * then `announce`s only once its inbox attaches. A `reserve` over an already-attached lease would
 * downgrade it, so the flow only ever goes reserve → announce, never back.
 */
export const reserve = (state: RegistryState, input: PresenceInput): RegistryState =>
	putLease(state, input, false);

/**
 * Claim `resource` on behalf of `holder`. Granted when the resource is free, held by a holder
 * whose presence has aged out (stale claim, reaped as free), or already held by `holder` itself
 * (re-claim refreshes without moving `since`); a Collision — leaving state untouched — when a
 * *different* holder with live presence holds it. Claim liveness derives from presence, so a
 * claim whose holder is no longer present is treated as free here (ADR 0191 facet 2).
 */
export const claimResource = (
	state: RegistryState,
	input: {
		readonly resource: string;
		readonly holder: string;
		readonly claimantRole: string;
		readonly nowMillis: number;
	},
): {readonly state: RegistryState; readonly outcome: ClaimOutcome} => {
	const {resource, holder, claimantRole, nowMillis} = input;
	const existing = state.claims.get(resource);
	if (
		existing &&
		existing.holder !== holder &&
		holderHasLivePresence(state.leases, existing.holder, nowMillis)
	) {
		return {
			state,
			outcome: {_tag: "Collision", holder: existing.holder, sinceMillis: existing.claimedAtMillis},
		};
	}
	const claimedAtMillis =
		existing && existing.holder === holder ? existing.claimedAtMillis : nowMillis;
	const claim: Claim = {resource, holder, claimantRole, claimedAtMillis};
	const claims = new Map(state.claims);
	claims.set(resource, claim);
	return {
		state: {...state, claims},
		outcome: {_tag: "Granted", holder, sinceMillis: claimedAtMillis},
	};
};

/**
 * Free the claim on `resource` — but ONLY if `claimant` is its holder. A peer cannot release a
 * claim it does not hold (steal-release is unrepresentable, ADR 0191 facet 3); releasing a claim
 * you do not hold or one that does not exist is an idempotent no-op.
 */
export const releaseClaim = (
	state: RegistryState,
	input: {readonly resource: string; readonly claimant: string},
): RegistryState => {
	const existing = state.claims.get(input.resource);
	if (!existing || existing.holder !== input.claimant) return state;
	const claims = new Map(state.claims);
	claims.delete(input.resource);
	return {...state, claims};
};

/**
 * The live holder of `resource`, or `undefined` when the resource is unclaimed or its holder's
 * presence has aged out (a stale claim reads as free). The read-side companion to `claimResource`.
 */
export const claimHolder = (
	state: RegistryState,
	resource: string,
	nowMillis: number,
): string | undefined => {
	const claim = state.claims.get(resource);
	if (!claim || !holderHasLivePresence(state.leases, claim.holder, nowMillis)) return undefined;
	return claim.holder;
};

/**
 * Refresh `peer`'s presence lease: bump `lastSeen` to now and adopt the heartbeat's TTL, PRESERVING
 * its attached phase (a beat keeps a serving peer discoverable, never downgrades it). Resource
 * claims are never touched — they have no TTL to bump, and their liveness rides presence (ADR 0191
 * facet 4). A beat for a peer with no lease is a no-op (nothing to refresh) — so a beat can never
 * manufacture presence for a session that never reserved/announced (#3628).
 */
export const heartbeat = (
	state: RegistryState,
	input: {readonly peer: string; readonly ttlSeconds: number; readonly nowMillis: number},
): RegistryState => {
	const {peer, ttlSeconds, nowMillis} = input;
	const lease = state.leases.get(peer);
	if (!lease) return state;
	const leases = new Map(state.leases);
	leases.set(peer, {...lease, ttlSeconds, lastSeenMillis: nowMillis});
	return {...state, leases};
};

/**
 * The present holders of `role` — every live, ATTACHED lease whose peer serves `role`, or `[]` when
 * none is. Only attached leases surface: a bare reservation (a slot held but the inbox not yet
 * serving) is deliberately invisible here, so a channel-deaf session is never returned as a live
 * peer (#3628). For a bridge the crew cardinality claim guarantees at most one live session, so the
 * set has one entry; for an engine the set carries every live instance in the pool (ADR 0189). An
 * empty array is the explicit not-present result (never a silent drop). Reads the presence keyspace
 * only, so it can never surface a resource-claim holder (ADR 0191).
 */
export const lookup = (
	state: RegistryState,
	role: string,
	nowMillis: number,
): ReadonlyArray<PresenceRecord> => {
	const present: Array<PresenceRecord> = [];
	for (const lease of state.leases.values()) {
		if (lease.role === role && lease.attached && isLive(lease, nowMillis)) {
			present.push({peer: lease.peer, role: lease.role, lastSeenMillis: lease.lastSeenMillis});
		}
	}
	return present;
};

/**
 * Free `peer`'s presence lease and reap every claim it holds — a graceful connection close
 * (connection-is-lease). The peer's presence is gone, so under presence-derived liveness its
 * claims are stale and dropped with it (ADR 0191 facet 2).
 */
export const release = (state: RegistryState, peer: string): RegistryState => {
	const leases = new Map(state.leases);
	leases.delete(peer);
	const claims = new Map(state.claims);
	for (const [resource, claim] of state.claims) {
		if (claim.holder === peer) claims.delete(resource);
	}
	return {leases, claims};
};

/**
 * Housekeeping: drop every lease aged past its TTL, then reap every claim whose holder no longer
 * has a live presence lease (ADR 0191 facet 2 — a claim never outlives its holder's presence).
 * Leases are pruned first so a claim is reaped against the freshly-pruned presence keyspace.
 */
export const prune = (state: RegistryState, nowMillis: number): RegistryState => {
	const leases = new Map(state.leases);
	for (const [peer, lease] of state.leases) {
		if (!isLive(lease, nowMillis)) leases.delete(peer);
	}
	const claims = new Map(state.claims);
	for (const [resource, claim] of state.claims) {
		if (!holderHasLivePresence(leases, claim.holder, nowMillis)) claims.delete(resource);
	}
	return {leases, claims};
};
