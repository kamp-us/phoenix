/**
 * standup/session-set — derive WHICH sessions the launcher stands up, straight from the kind-typed
 * roster + its per-kind cardinality contract (ADR 0189): one instance per bridge kind, N instances
 * of the engine kind (N from the config engine-count dimension). Pure over the roster contract — no
 * process spawn, no argv (the bind constructor #3296 turns each `{role, address}` into argv, the
 * orchestration child spawns them).
 *
 * The set is derived by iterating the roster (`CREW_ROLES` + `kindOf`), never a re-declared role
 * list, so a roster change flows through here with no edit. Each session carries the `address`
 * `inboxAddressFor` mints — which IS its role-lease key: a bridge's singleton `inbox://<role>` (its
 * cardinality-1 lease keeps discover→dial deterministic), an engine's per-instance
 * `inbox://<role>/<instance>` (N distinct leases + N collision-free inbox sockets). Bridge sessions
 * carry no instance because a bridge-with-an-instance is meaningless — the discriminated union makes
 * that state unrepresentable, mirroring `inboxAddressFor`'s own kind branch.
 */
import {CREW_ROLES, type CrewRole, inboxAddressFor, kindOf} from "../crew/index.ts";
import type {EngineCount} from "./config.ts";

/**
 * A launcher session bound to its role lease. `kind` discriminates the union: a bridge is the
 * cardinality-1 singleton (no per-instance identity), an engine carries a distinct `instance` so N
 * of them coexist. `address` is `inboxAddressFor(role, …)` — the dialable inbox AND the lease key
 * the session comes up holding.
 */
export interface BridgeSession {
	readonly kind: "bridge";
	readonly role: CrewRole;
	readonly address: string;
}

export interface EngineSession {
	readonly kind: "engine";
	readonly role: CrewRole;
	/** The distinct per-instance discriminator baked into `address` — no two engine inboxes collide. */
	readonly instance: string;
	readonly address: string;
}

export type CrewSession = BridgeSession | EngineSession;

export interface SessionSetInput {
	/** N — how many engine sessions to start, the validated (≥1) `EngineCount` from `LaunchConfig`. */
	readonly engineCount: EngineCount;
	/**
	 * Mints a distinct per-instance id per engine session — injected so the derivation is pure and
	 * testable; production passes `randomUUID` (the same generator `crewSessionLayer` threads through
	 * `inboxAddressFor`). Called exactly once per engine instance, never for a bridge.
	 */
	readonly instanceId: () => string;
}

/**
 * Derive the stand-up's session set from the roster-law contract: exactly one bridge session per
 * bridge role and `engineCount` sessions per engine role, each engine instance addressed distinctly.
 * Total by construction — every roster role is kinded, so no role is dropped or double-counted.
 */
export const deriveSessionSet = (input: SessionSetInput): readonly CrewSession[] => {
	const {engineCount, instanceId} = input;
	const sessions: CrewSession[] = [];
	for (const role of CREW_ROLES) {
		if (kindOf(role) === "engine") {
			for (let i = 0; i < engineCount; i++) {
				const instance = instanceId();
				sessions.push({kind: "engine", role, instance, address: inboxAddressFor(role, instance)});
			}
		} else {
			// A bridge is cardinality 1; `inboxAddressFor` ignores the instance for a bridge kind and
			// returns the singleton `inbox://<role>`, so no id is minted for it.
			sessions.push({kind: "bridge", role, address: inboxAddressFor(role, "")});
		}
	}
	return sessions;
};
