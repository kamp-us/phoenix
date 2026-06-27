/**
 * `Grant` — the unforgeable proof that a capability check was discharged
 * (ADR 0107 §1). It is **sealed**, two ways that matter:
 *
 *   1. **Its constructor never escapes.** Only the {@link Grant} *type* is
 *      exported from the package; the {@link mint} factory is internal (the
 *      barrel re-exports the type and {@link isGrant}, never `mint`). A consumer
 *      can hold and pass a `Grant`, but cannot fabricate one — the only source
 *      is discharging a real check via a `Capability` discharge verb.
 *   2. **It is not a `Schema`.** A decodable proof would be forgeable (decode a
 *      crafted payload → a valid-looking proof). `Grant` has no codec, no AST,
 *      no decode path; it is a branded plain object, period.
 *
 * The proof carries the {@link Actor} it was minted for and the {@link GrantScope}
 * proved (the capability tag, and the resource or level the check covered) — but
 * **not a level to compare at the callsite**: capabilities are named by the
 * right they grant, so the wrong right's proof is the wrong *type*, never a
 * runtime level comparison (ADR 0107 §2).
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
 * so a proof of one right does not satisfy another. Branded with an internal
 * symbol; the brand is type-only ({@link mint} is the sole construction site and
 * never leaves the package), so no external value inhabits this type.
 */
export interface Grant<out M> {
	readonly [GrantTypeId]: M;
	readonly actor: Actor;
	readonly scope: GrantScope;
}

/**
 * Mint a {@link Grant}. **Package-internal** — never re-exported from the
 * barrel, so the only way a consumer obtains a `Grant` is by discharging a real
 * check through a `Capability` discharge verb. The single named cast widens the
 * runtime marker into the phantom-branded type; the brand carries no runtime
 * value (it is the seal, not data).
 */
export const mint = <M>(actor: Actor, scope: GrantScope): Grant<M> => {
	const proof = {[GrantTypeId]: true, actor, scope};
	return proof as Grant<M>;
};

/** Structural guard: is `value` a minted {@link Grant}? */
export const isGrant = (value: unknown): value is Grant<unknown> =>
	typeof value === "object" && value !== null && GrantTypeId in value;
