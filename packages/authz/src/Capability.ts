/**
 * `Capability` — the class-as-capability builders (ADR 0107 §3). One class
 * declaration yields, from a single name, the proof tag (a v4
 * `Context.Key<Self, Grant<Self>>`), the {@link Grant} it proves, a discharge
 * verb that mints the proof by running a check, and `.provide` that flows the
 * proof into an effect's R channel. The non-obvious part: enforcement is by the
 * R channel, not a domain field — an op that declares the capability in its R
 * fails to compile unless the proof is provided at composition.
 *
 * Three builders, the asymmetric axes of ADR 0107 §4:
 *   - {@link Class} — generic: `.authorize(check)` discharges a boolean check.
 *   - {@link Level} — ordered ladder: `.require` discharges when standing `gte` the floor.
 *   - {@link Relation} — ReBAC: `.over(resource)` discharges over the resource's ancestry.
 *
 * Both specializations dispatch exhaustively on the {@link Actor} via
 * {@link matchActor}, consulting {@link AgentAuthority} (dormant, fail-closed in
 * v1) on the agent arm; the `deny()` thunk is instance-supplied (the mechanism
 * names no wire code). See .patterns/authz-capability-as-effect.md.
 */
import {Context, Effect} from "effect";
import {matchActor, type Principal} from "./Actor.ts";
import {AgentAuthority} from "./AgentAuthority.ts";
import {CurrentActor} from "./CurrentActor.ts";
import {type Grant, mint} from "./Grant.ts";
import type {Scale} from "./Level.ts";
import {RelationStore} from "./Relation.ts";
import {ancestry, type Resource} from "./Resource.ts";

/**
 * The `.provide` seam shared by every capability class: `provideService` of a
 * {@link Grant} into R, removing the capability from requirements — so an op
 * that declares it but never provides the proof fails to compile.
 */
export interface CapabilityProvide<Self> {
	provide(
		grant: Grant<Self>,
	): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, Self>>;
}

/**
 * The shared face of every capability class: a v4 `Context.Key<Self,
 * Grant<Self>>` proof tag, the class constructor, and `.provide`.
 *
 * Intentionally an intersection, NOT `interface extends Context.Service`:
 * extending the service folds `.provide`/the discharge verbs into the type's
 * `EffectUnify`, which then fails to match the bare service the class actually
 * is. Keeping the statics as their own members leaves the Effect-typed member
 * pure.
 */
export type CapabilityTag<Self> = Context.Service<Self, Grant<Self>> &
	(new (
		_: never,
	) => Context.ServiceClass.Shape<string, Grant<Self>>) & {
		readonly key: string;
	} & CapabilityProvide<Self>;

/** The generic base capability — discharged by a caller-supplied check. */
export type ClassCapability<Self, DenyError> = CapabilityTag<Self> & {
	authorize<E, R>(
		check: Effect.Effect<boolean, E, R>,
	): Effect.Effect<Grant<Self>, DenyError | E, CurrentActor | R>;
};

/** A `Level`-axis capability — discharged by reading standing against a floor. */
export type LevelCapability<Self, DenyError, ReadError, ReadReqs> = CapabilityTag<Self> & {
	readonly require: Effect.Effect<
		Grant<Self>,
		DenyError | ReadError,
		CurrentActor | AgentAuthority | ReadReqs
	>;
};

/** A `Relation`-axis capability — discharged over a resource's ancestry. */
export type RelationCapability<Self, DenyError> = CapabilityTag<Self> & {
	over(
		object: Resource,
	): Effect.Effect<Grant<Self>, DenyError, CurrentActor | RelationStore | AgentAuthority>;
};

/** Config for {@link Class}. */
export interface ClassConfig<DenyError> {
	readonly deny: () => DenyError;
}

/** Config for {@link Level}. */
export interface LevelConfig<Name extends string, DenyError, ReadError, ReadReqs> {
	/** The ordered ladder the `min` floor is compared on. */
	readonly scale: Scale<Name>;
	/** The minimum standing this right requires (the floor). */
	readonly min: Name;
	/** Read a principal's current standing on the ladder. */
	readonly read: (principal: Principal) => Effect.Effect<Name, ReadError, ReadReqs>;
	readonly deny: () => DenyError;
}

/** Config for {@link Relation}. */
export interface RelationConfig<DenyError> {
	/** The relation name (the ReBAC verb, e.g. `moderates`). */
	readonly relation: string;
	readonly deny: () => DenyError;
}

/**
 * Bridge a freshly-built capability class to its augmented public type — the
 * ONE audited coercion in the package: a single cast across an `unknown`
 * boundary (the plugin's permitted single-cast form, not `as any`), pinned by
 * `Capability.typetest.ts` + the unit tests. It is what lets each internal class
 * name ITSELF as its Service `Self` (`class Tag extends Context.Service<Tag,
 * …>` — the effect-class `classSelfMismatch` convention, run as an error by
 * `@effect/tsgo`) while consumers see the external `Self`-parameterized type.
 * Full derivation — the effect-smol `Unify` limit `HttpApiMiddleware.Service`
 * hits the same way — is in .patterns/authz-capability-as-effect.md.
 */
const sealCapability = <T>(tag: unknown): T => tag as T;

/**
 * `Capability.Class<Self>()(id, { deny })` — the generic base builder. The
 * discharge verb `.authorize(check)` reads the current actor (to stamp the
 * proof), runs the caller's boolean `check`, and mints on success or raises
 * `deny()` otherwise.
 */
const makeClass =
	<Self>() =>
	<const Id extends string, DenyError>(
		id: Id,
		config: ClassConfig<DenyError>,
	): ClassCapability<Self, DenyError> => {
		const {deny} = config;
		// Self-identity is `Tag`, bridged to the external `Self` by `sealCapability`.
		class Tag extends Context.Service<Tag, Grant<Self>>()(id) {
			static provide(grant: Grant<Self>) {
				return <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Tag>> =>
					Effect.provideService(self, Tag, grant);
			}

			static authorize<E, R>(
				check: Effect.Effect<boolean, E, R>,
			): Effect.Effect<Grant<Self>, DenyError | E, CurrentActor | R> {
				return Effect.gen(function* () {
					const {actor} = yield* CurrentActor;
					const passed = yield* check;
					if (passed) return mint<Self>(actor, {capability: id});
					return yield* Effect.fail(deny());
				});
			}
		}
		return sealCapability(Tag);
	};

/**
 * `Capability.Level<Self>()(id, { scale, min, read, deny })` — the ordered-ladder
 * builder. The discharge verb `.require` reads the actor's standing and mints
 * when it `gte` the floor; an agent passes only when its human root's standing
 * passes *and* {@link AgentAuthority} admits the attenuation.
 */
const makeLevel =
	<Self>() =>
	<const Id extends string, Name extends string, DenyError, ReadError, ReadReqs>(
		id: Id,
		config: LevelConfig<Name, DenyError, ReadError, ReadReqs>,
	): LevelCapability<Self, DenyError, ReadError, ReadReqs> => {
		const {scale, min, read, deny} = config;
		type Branch = Effect.Effect<Grant<Self>, DenyError | ReadError, AgentAuthority | ReadReqs>;
		// Self-identity is `Tag`, bridged to the external `Self` by `sealCapability` (see makeClass).
		class Tag extends Context.Service<Tag, Grant<Self>>()(id) {
			static provide(grant: Grant<Self>) {
				return <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Tag>> =>
					Effect.provideService(self, Tag, grant);
			}

			static readonly require: Effect.Effect<
				Grant<Self>,
				DenyError | ReadError,
				CurrentActor | AgentAuthority | ReadReqs
			> = Effect.gen(function* () {
				const {actor} = yield* CurrentActor;
				return yield* matchActor<Branch>(actor, {
					onUnauthenticated: () => Effect.fail(deny()),
					onHuman: (subject) =>
						Effect.gen(function* () {
							const level = yield* read(subject);
							if (scale.gte(level, min)) return mint<Self>(actor, {capability: id, level});
							return yield* Effect.fail(deny());
						}),
					onAgent: (acting) =>
						Effect.gen(function* () {
							const rootLevel = yield* read({_tag: "Human", id: acting.root});
							const authority = yield* AgentAuthority;
							const admitted = yield* authority.admits({agent: acting, capability: id});
							if (scale.gte(rootLevel, min) && admitted) {
								return mint<Self>(actor, {capability: id, level: rootLevel});
							}
							return yield* Effect.fail(deny());
						}),
				});
			});
		}
		return sealCapability(Tag);
	};

/**
 * `Capability.Relation<Self>()(id, { relation, deny })` — the ReBAC builder. The
 * discharge verb `.over(resource)` mints when the actor holds `relation` over
 * the resource or any of its ancestors (checked fresh, once per ancestor); an
 * agent passes only when its human root holds it *and* {@link AgentAuthority}
 * admits the attenuation.
 */
const makeRelation =
	<Self>() =>
	<const Id extends string, DenyError>(
		id: Id,
		config: RelationConfig<DenyError>,
	): RelationCapability<Self, DenyError> => {
		const {relation, deny} = config;
		type Branch = Effect.Effect<Grant<Self>, DenyError, AgentAuthority>;
		// Self-identity is `Tag`, bridged to the external `Self` by `sealCapability` (see makeClass).
		class Tag extends Context.Service<Tag, Grant<Self>>()(id) {
			static provide(grant: Grant<Self>) {
				return <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Tag>> =>
					Effect.provideService(self, Tag, grant);
			}

			static over(
				object: Resource,
			): Effect.Effect<Grant<Self>, DenyError, CurrentActor | RelationStore | AgentAuthority> {
				return Effect.gen(function* () {
					const {actor} = yield* CurrentActor;
					const store = yield* RelationStore;
					const heldBy = (subject: string): Effect.Effect<boolean> =>
						Effect.gen(function* () {
							for (const node of ancestry(object)) {
								if (yield* store.has({subject, relation, object: node})) return true;
							}
							return false;
						});
					return yield* matchActor<Branch>(actor, {
						onUnauthenticated: () => Effect.fail(deny()),
						onHuman: (subject) =>
							Effect.gen(function* () {
								if (yield* heldBy(subject.id)) {
									return mint<Self>(actor, {capability: id, resource: object});
								}
								return yield* Effect.fail(deny());
							}),
						onAgent: (acting) =>
							Effect.gen(function* () {
								const rootHolds = yield* heldBy(acting.root);
								const authority = yield* AgentAuthority;
								const admitted = yield* authority.admits({agent: acting, capability: id});
								if (rootHolds && admitted) {
									return mint<Self>(actor, {capability: id, resource: object});
								}
								return yield* Effect.fail(deny());
							}),
					});
				});
			}
		}
		return sealCapability(Tag);
	};

/**
 * The class-as-capability builders. Each is `<Self>()(id, config)` — the
 * effect-class `Self`-type curry, so `class X extends Capability.Level<X>()(…)`
 * names the proof tag, the `Grant` type, the discharge verb, and `.provide`
 * from the one declaration.
 */
export const Capability = {
	Class: makeClass,
	Level: makeLevel,
	Relation: makeRelation,
} as const;
