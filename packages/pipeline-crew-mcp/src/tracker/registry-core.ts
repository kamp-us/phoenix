/**
 * tracker/registry-core — the soft-state presence registry as a pure data structure.
 *
 * No Effect, no IO: state transitions only, so the announce / lookup / heartbeat-TTL /
 * role-lease and resource-claim semantics are unit-testable in isolation from the socket
 * transport. The service (`./registry.ts`) holds one of these in a `Ref` and supplies the clock.
 *
 * Two keyspaces that never share a map (ADR 0191): role/presence leases keyed by `role`, and
 * resource claims keyed by `resource`. A role lease and an issue claim are different lifecycles —
 * keeping them in distinct typed maps makes "a `lookup` returns a claim holder" unrepresentable
 * rather than checked after the fact.
 *
 * The three non-obvious model choices:
 *   - A role maps to at MOST ONE live lease (`leases` is keyed by role) — that is how "named
 *     leases for role uniqueness" is made unrepresentable-otherwise rather than checked after the
 *     fact: you cannot store two live holders of one role.
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

/** The default presence TTL applied on acquire, until the first `heartbeat` sets a real one. */
export const DEFAULT_TTL_SECONDS = 30;

/** One role lease: who holds the role, when they took it, and their soft-state liveness window. */
export interface Lease {
	readonly role: string;
	readonly peer: string;
	readonly ttlSeconds: number;
	readonly leasedAtMillis: number;
	readonly lastSeenMillis: number;
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

/** The whole registry: role/presence leases and resource claims in two separate keyspaces. */
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
 * The result of an acquire: `Granted` when the caller now holds the role, `Collision` when a
 * different live peer already holds it (the lease is NOT stolen — the incumbent keeps it).
 */
export type AcquireOutcome =
	| {readonly _tag: "Granted"; readonly owner: string; readonly sinceMillis: number}
	| {readonly _tag: "Collision"; readonly owner: string; readonly sinceMillis: number};

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

/** True iff `holder` holds any live presence lease — the claim-liveness clock (ADR 0191 facet 2). */
const holderHasLivePresence = (
	leases: ReadonlyMap<string, Lease>,
	holder: string,
	nowMillis: number,
): boolean => {
	for (const lease of leases.values()) {
		if (lease.peer === holder && isLive(lease, nowMillis)) return true;
	}
	return false;
};

/**
 * Acquire the lease for `role` on behalf of `peer`. Granted when the role is free, held by an
 * expired peer, or already held by `peer` itself (re-announce refreshes without moving `since`);
 * a Collision — leaving state untouched — when a *different* live peer holds it.
 */
export const acquire = (
	state: RegistryState,
	input: {
		readonly role: string;
		readonly peer: string;
		readonly ttlSeconds: number;
		readonly nowMillis: number;
	},
): {readonly state: RegistryState; readonly outcome: AcquireOutcome} => {
	const {role, peer, ttlSeconds, nowMillis} = input;
	const existing = state.leases.get(role);
	if (existing && existing.peer !== peer && isLive(existing, nowMillis)) {
		return {
			state,
			outcome: {_tag: "Collision", owner: existing.peer, sinceMillis: existing.leasedAtMillis},
		};
	}
	const leasedAtMillis = existing && existing.peer === peer ? existing.leasedAtMillis : nowMillis;
	const lease: Lease = {role, peer, ttlSeconds, leasedAtMillis, lastSeenMillis: nowMillis};
	const leases = new Map(state.leases);
	leases.set(role, lease);
	return {
		state: {...state, leases},
		outcome: {_tag: "Granted", owner: peer, sinceMillis: leasedAtMillis},
	};
};

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
 * Refresh every role lease held by `peer`: bump `lastSeen` to now and adopt the heartbeat's TTL.
 * Resource claims are never touched — they have no TTL to bump, and their liveness rides presence
 * (ADR 0191 facet 4). Because the keyspaces are split, this loop over `leases` is presence-only
 * by construction.
 */
export const heartbeat = (
	state: RegistryState,
	input: {readonly peer: string; readonly ttlSeconds: number; readonly nowMillis: number},
): RegistryState => {
	const {peer, ttlSeconds, nowMillis} = input;
	const leases = new Map(state.leases);
	for (const [role, lease] of state.leases) {
		if (lease.peer === peer) {
			leases.set(role, {...lease, ttlSeconds, lastSeenMillis: nowMillis});
		}
	}
	return {...state, leases};
};

/**
 * The present holders of `role` — the single live lease, or `[]` when the role is absent or its
 * holder has aged out. An empty array is the explicit not-present result (never a silent drop).
 * Reads the presence keyspace only, so it can never surface a resource-claim holder (ADR 0191).
 */
export const lookup = (
	state: RegistryState,
	role: string,
	nowMillis: number,
): ReadonlyArray<PresenceRecord> => {
	const lease = state.leases.get(role);
	if (!lease || !isLive(lease, nowMillis)) return [];
	return [{peer: lease.peer, role: lease.role, lastSeenMillis: lease.lastSeenMillis}];
};

/**
 * Free every lease held by `peer` and reap every claim it holds — a graceful connection close
 * (connection-is-lease). The peer's presence is gone, so under presence-derived liveness its
 * claims are stale and dropped with it (ADR 0191 facet 2).
 */
export const release = (state: RegistryState, peer: string): RegistryState => {
	const leases = new Map(state.leases);
	for (const [role, lease] of state.leases) {
		if (lease.peer === peer) leases.delete(role);
	}
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
	for (const [role, lease] of state.leases) {
		if (!isLive(lease, nowMillis)) leases.delete(role);
	}
	const claims = new Map(state.claims);
	for (const [resource, claim] of state.claims) {
		if (!holderHasLivePresence(leases, claim.holder, nowMillis)) claims.delete(resource);
	}
	return {leases, claims};
};
