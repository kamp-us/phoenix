/**
 * `Grant` — the unforgeable proof that a capability check was discharged
 * (ADR 0107 §1). Sealed two ways: {@link mint} never leaves the package (the
 * barrel re-exports the type and {@link isGrant}, never `mint`), and it is not a
 * `Schema` (a decodable proof would be forgeable) — a branded plain object, no
 * codec, no decode path. It carries the {@link Actor} and the {@link GrantScope}
 * proved, but no level to compare at the callsite: the wrong right's proof is
 * the wrong *type*. See .patterns/authz-capability-as-effect.md.
 */
import {type Context, Effect} from "effect";
import type {Actor} from "./Actor.ts";
import type {Resource} from "./Resource.ts";

const GrantTypeId: unique symbol = Symbol.for("@kampus/authz/Grant");

// Module-local (NOT Symbol.for): the runtime capability `Context.Key` stamped onto a
// grant at mint, read by `Grant.provide` to discharge. Unnameable outside this module and
// stamped non-enumerable, so it neither widens the `Grant` type nor breaks the seal — a Key
// reference is not a decode path, and `mint` is still the sole, package-internal way in.
const GrantKeyId: unique symbol = Symbol("@kampus/authz/Grant/key");

export interface GrantScope {
	readonly capability: string;
	/** Set for a `Relation` grant: the resource the authority was proved over. */
	readonly resource?: Resource | undefined;
	/** Set for a `Level` grant: the standing rank the actor was found to hold. */
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
 * Package-internal — never re-exported, so a consumer can only obtain a
 * `Grant` by discharging a real check. The key is stamped **non-enumerable**
 * so `Grant.provide` can discharge generically without the key entering the
 * `Grant` type or any decode path — that is what holds the seal.
 */
export const mint = <M>(
	actor: Actor,
	scope: GrantScope,
	key: Context.Key<unknown, unknown>,
): Grant<M> => {
	const proof = {[GrantTypeId]: true, actor, scope};
	Object.defineProperty(proof, GrantKeyId, {value: key, enumerable: false});
	return proof as Grant<M>;
};

export const isGrant = (value: unknown): value is Grant<unknown> =>
	typeof value === "object" && value !== null && GrantTypeId in value;

/**
 * The single canonical discharge verb (ADR 0107). It routes by the key the
 * grant itself carries, never by a named capability's key: a wrong-capability
 * grant therefore leaves the requirement unsatisfied and fails loud, instead
 * of silently satisfying it the way the old static verb did (#1270, #1483).
 */
const provide =
	<C>(grant: Grant<C>) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, C>> => {
		const key = (grant as Grant<C> & {readonly [GrantKeyId]: Context.Key<C, Grant<C>>})[GrantKeyId];
		return Effect.provideService(self, key, grant);
	};

export const Grant = {provide} as const;
