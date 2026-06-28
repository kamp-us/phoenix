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
 * marker into the phantom-branded type (the brand is the seal, not data). The
 * capability's `Context.Key` is stamped **non-enumerable** so {@link Grant.provide}
 * can discharge the proof generically without the key entering the `Grant` type or
 * any decode path — the seal holds.
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

/** Structural guard: is `value` a minted {@link Grant}? */
export const isGrant = (value: unknown): value is Grant<unknown> =>
	typeof value === "object" && value !== null && GrantTypeId in value;

/**
 * Discharge a proof into an op's requirements channel — the single canonical
 * provide verb (ADR 0107, collapsed from the per-capability `Cap.provide` in #1270).
 * Generic over `Grant<C>`: it reads the capability `Context.Key` the grant carries
 * (stamped by {@link mint}) and `provideService`s the grant under **that** key,
 * removing `C` from the effect's `R` channel. Because it routes by the grant's own
 * key, a grant for capability X discharges only X's requirement — a wrong-capability
 * grant leaves the op's requirement unsatisfied (a fail-loud runtime defect, where
 * the old static verb silently provided any grant under the *named* capability's key).
 * The type-level brand also distinguishes capabilities: the sealed `CapabilityTag` carries
 * each capability's `id` literal, so `Grant<X>` ≢ `Grant<Y>` and a wrong-proof is a compile
 * error too (#1483 — the brand is phantom, no runtime change here).
 */
const provide =
	<C>(grant: Grant<C>) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, C>> => {
		const key = (grant as Grant<C> & {readonly [GrantKeyId]: Context.Key<C, Grant<C>>})[GrantKeyId];
		return Effect.provideService(self, key, grant);
	};

/**
 * The `Grant` value namespace (merged with the `Grant<M>` type above): carries the
 * canonical discharge verb {@link provide} and nothing that forges a proof — `mint`
 * stays package-internal, so the seal is unchanged.
 */
export const Grant = {provide} as const;
