/**
 * `Grant` — the unforgeable proof that a capability check was discharged
 * (ADR 0107 §1). Sealed two ways: {@link mint} never leaves the package (the
 * barrel re-exports the type and {@link isGrant}, never `mint`), and it is not a
 * `Schema` (a decodable proof would be forgeable) — a branded plain object, no
 * codec, no decode path. It carries the {@link Actor} and the {@link GrantScope}
 * proved, but no level to compare at the callsite: the wrong right's proof is
 * the wrong *type*. See .patterns/authz-capability-as-effect.md.
 */
import type {Actor} from "./Actor.ts";
import type {Resource} from "./Resource.ts";

const GrantTypeId: unique symbol = Symbol.for("@kampus/authz/Grant");

/** What a {@link Grant} proves: its capability tag and the scope the check covered. */
export interface GrantScope {
	/** The capability tag (the right) this grant proves. */
	readonly capability: string;
	/** For a `Relation` grant, the resource the authority was proved over. */
	readonly resource?: Resource | undefined;
	/** For a `Level` grant, the standing rank the actor was found to hold. */
	readonly level?: string | undefined;
}

/**
 * The proof a capability check passed, phantom-keyed by the capability tag `M`
 * so a proof of one right does not satisfy another.
 */
export interface Grant<out M> {
	readonly [GrantTypeId]: M;
	readonly actor: Actor;
	readonly scope: GrantScope;
}

/**
 * Mint a {@link Grant}. Package-internal — never re-exported, so a consumer can
 * only obtain a `Grant` by discharging a real check. The cast widens the runtime
 * marker into the phantom-branded type (the brand is the seal, not data).
 */
export const mint = <M>(actor: Actor, scope: GrantScope): Grant<M> => {
	const proof = {[GrantTypeId]: true, actor, scope};
	return proof as Grant<M>;
};

/** Structural guard: is `value` a minted {@link Grant}? */
export const isGrant = (value: unknown): value is Grant<unknown> =>
	typeof value === "object" && value !== null && GrantTypeId in value;
