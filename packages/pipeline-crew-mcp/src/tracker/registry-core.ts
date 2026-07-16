/**
 * tracker/registry-core — the soft-state presence registry as a pure data structure.
 *
 * No Effect, no IO: state transitions only, so the announce / lookup / heartbeat-TTL /
 * role-lease semantics are unit-testable in isolation from the socket transport. The
 * service (`./registry.ts`) holds one of these in a `Ref` and supplies the clock.
 *
 * The two non-obvious model choices:
 *   - A role maps to at MOST ONE live lease (`RegistryState` is keyed by role) — that is
 *     how "named leases for role uniqueness" is made unrepresentable-otherwise rather than
 *     checked after the fact: you cannot store two live holders of one role.
 *   - "Connection-is-lease" is modelled by the peer id being the connection identity, and
 *     liveness being measured against the tracker's own clock (never the client-supplied
 *     `at`): a peer that stops heart-beating ages past its TTL and its lease frees, and an
 *     explicit `release` (a graceful connection close) frees it immediately. A client can't
 *     extend its own liveness by lying about `at`.
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

/** The whole registry: one live lease per role (role uniqueness is structural). */
export type RegistryState = ReadonlyMap<string, Lease>;

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

/** A fresh, empty registry. */
export const empty = (): RegistryState => new Map();

const isLive = (lease: Lease, nowMillis: number): boolean =>
	nowMillis <= lease.lastSeenMillis + lease.ttlSeconds * 1000;

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
	const existing = state.get(role);
	if (existing && existing.peer !== peer && isLive(existing, nowMillis)) {
		return {
			state,
			outcome: {_tag: "Collision", owner: existing.peer, sinceMillis: existing.leasedAtMillis},
		};
	}
	const leasedAtMillis = existing && existing.peer === peer ? existing.leasedAtMillis : nowMillis;
	const lease: Lease = {role, peer, ttlSeconds, leasedAtMillis, lastSeenMillis: nowMillis};
	const next = new Map(state);
	next.set(role, lease);
	return {state: next, outcome: {_tag: "Granted", owner: peer, sinceMillis: leasedAtMillis}};
};

/** Refresh every lease held by `peer`: bump `lastSeen` to now and adopt the heartbeat's TTL. */
export const heartbeat = (
	state: RegistryState,
	input: {readonly peer: string; readonly ttlSeconds: number; readonly nowMillis: number},
): RegistryState => {
	const {peer, ttlSeconds, nowMillis} = input;
	const next = new Map(state);
	for (const [role, lease] of state) {
		if (lease.peer === peer) {
			next.set(role, {...lease, ttlSeconds, lastSeenMillis: nowMillis});
		}
	}
	return next;
};

/**
 * The present holders of `role` — the single live lease, or `[]` when the role is absent or its
 * holder has aged out. An empty array is the explicit not-present result (never a silent drop).
 */
export const lookup = (
	state: RegistryState,
	role: string,
	nowMillis: number,
): ReadonlyArray<PresenceRecord> => {
	const lease = state.get(role);
	if (!lease || !isLive(lease, nowMillis)) return [];
	return [{peer: lease.peer, role: lease.role, lastSeenMillis: lease.lastSeenMillis}];
};

/** Free every lease held by `peer` — a graceful connection close (connection-is-lease). */
export const release = (state: RegistryState, peer: string): RegistryState => {
	const next = new Map(state);
	for (const [role, lease] of state) {
		if (lease.peer === peer) next.delete(role);
	}
	return next;
};

/** Housekeeping: drop every lease that has aged past its TTL as of `nowMillis`. */
export const prune = (state: RegistryState, nowMillis: number): RegistryState => {
	const next = new Map(state);
	for (const [role, lease] of state) {
		if (!isLive(lease, nowMillis)) next.delete(role);
	}
	return next;
};
