/**
 * `Capability` — the class-as-capability builders (ADR 0107 §3/§4, and
 * .patterns/authz-capability-as-effect.md). The non-obvious part: enforcement
 * is by the R channel, not a domain field — an op that declares the capability
 * in its R fails to compile unless the proof is provided at composition.
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
 * The shared face of every capability class: a v4 `Context.Key<Self,
 * Grant<Self>>` proof tag and the class constructor. (Discharge is `Grant.provide`,
 * not a per-class member — collapsed in #1270.)
 *
 * Intentionally an intersection, NOT `interface extends Context.Service`:
 * extending the service folds the discharge verbs into the type's `EffectUnify`,
 * which then fails to match the bare service the class actually is. Keeping the
 * statics as their own members leaves the Effect-typed member pure.
 *
 * Parameterized by the `Id` string literal as well as `Self`, mirroring
 * effect-smol's `Context.ServiceClass<Self, Identifier, Shape>` (Context.ts):
 * carrying `Id` keeps each capability **nominally distinct**. Widening the three
 * id sites to `string` (the pre-#1483 seal) collapsed two capabilities to the
 * same structural type, so `Grant<X>`/`Grant<Y>` unified and a wrong-right proof
 * was undetectable at compile time. With `Id` carried, `Grant<X>` ≢ `Grant<Y>`
 * (the brand propagates through `Grant<out M = Self>`). The brand is phantom —
 * type-level only, erased at emit; no runtime property is added (the
 * unforgeable-proof seal lives in `Grant.ts`'s runtime `mint`/`provide`).
 */
export type CapabilityTag<Self, Id extends string> = Context.ServiceClass<Self, Id, Grant<Self>> &
	(new (
		_: never,
	) => Context.ServiceClass.Shape<Id, Grant<Self>>) & {
		readonly key: Id;
	};

export type ClassCapability<Self, Id extends string, DenyError> = CapabilityTag<Self, Id> & {
	authorize<E, R>(
		check: Effect.Effect<boolean, E, R>,
	): Effect.Effect<Grant<Self>, DenyError | E, CurrentActor | R>;
};

export type LevelCapability<
	Self,
	Id extends string,
	DenyError,
	ReadError,
	ReadReqs,
> = CapabilityTag<Self, Id> & {
	readonly require: Effect.Effect<
		Grant<Self>,
		DenyError | ReadError,
		CurrentActor | AgentAuthority | ReadReqs
	>;
};

export type RelationCapability<Self, Id extends string, DenyError> = CapabilityTag<Self, Id> & {
	over(
		object: Resource,
	): Effect.Effect<Grant<Self>, DenyError, CurrentActor | RelationStore | AgentAuthority>;
};

export interface ClassConfig<DenyError> {
	readonly deny: () => DenyError;
}

export interface LevelConfig<Name extends string, DenyError, ReadError, ReadReqs> {
	readonly scale: Scale<Name>;
	readonly min: Name;
	readonly read: (principal: Principal) => Effect.Effect<Name, ReadError, ReadReqs>;
	readonly deny: () => DenyError;
}

export interface RelationConfig<DenyError> {
	/** The ReBAC verb, e.g. `moderates`. */
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

const makeClass =
	<Self>() =>
	<const Id extends string, DenyError>(
		id: Id,
		config: ClassConfig<DenyError>,
	): ClassCapability<Self, Id, DenyError> => {
		const {deny} = config;
		// Self-identity is `Tag`, bridged to the external `Self` by `sealCapability`.
		class Tag extends Context.Service<Tag, Grant<Self>>()(id) {
			static authorize<E, R>(
				check: Effect.Effect<boolean, E, R>,
			): Effect.Effect<Grant<Self>, DenyError | E, CurrentActor | R> {
				return Effect.gen(function* () {
					const {actor} = yield* CurrentActor;
					const passed = yield* check;
					if (passed) return mint<Self>(actor, {capability: id}, Tag);
					return yield* Effect.fail(deny());
				});
			}
		}
		return sealCapability(Tag);
	};

const makeLevel =
	<Self>() =>
	<const Id extends string, Name extends string, DenyError, ReadError, ReadReqs>(
		id: Id,
		config: LevelConfig<Name, DenyError, ReadError, ReadReqs>,
	): LevelCapability<Self, Id, DenyError, ReadError, ReadReqs> => {
		const {scale, min, read, deny} = config;
		type Branch = Effect.Effect<Grant<Self>, DenyError | ReadError, AgentAuthority | ReadReqs>;
		// Self-identity is `Tag`, bridged to the external `Self` by `sealCapability` (see makeClass).
		class Tag extends Context.Service<Tag, Grant<Self>>()(id) {
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
							if (scale.gte(level, min)) return mint<Self>(actor, {capability: id, level}, Tag);
							return yield* Effect.fail(deny());
						}),
					onAgent: (acting) =>
						Effect.gen(function* () {
							const rootLevel = yield* read({_tag: "Human", id: acting.root});
							const authority = yield* AgentAuthority;
							const admitted = yield* authority.admits({agent: acting, capability: id});
							if (scale.gte(rootLevel, min) && admitted) {
								return mint<Self>(actor, {capability: id, level: rootLevel}, Tag);
							}
							return yield* Effect.fail(deny());
						}),
				});
			});
		}
		return sealCapability(Tag);
	};

const makeRelation =
	<Self>() =>
	<const Id extends string, DenyError>(
		id: Id,
		config: RelationConfig<DenyError>,
	): RelationCapability<Self, Id, DenyError> => {
		const {relation, deny} = config;
		type Branch = Effect.Effect<Grant<Self>, DenyError, AgentAuthority>;
		// Self-identity is `Tag`, bridged to the external `Self` by `sealCapability` (see makeClass).
		class Tag extends Context.Service<Tag, Grant<Self>>()(id) {
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
									return mint<Self>(actor, {capability: id, resource: object}, Tag);
								}
								return yield* Effect.fail(deny());
							}),
						onAgent: (acting) =>
							Effect.gen(function* () {
								const rootHolds = yield* heldBy(acting.root);
								const authority = yield* AgentAuthority;
								const admitted = yield* authority.admits({agent: acting, capability: id});
								if (rootHolds && admitted) {
									return mint<Self>(actor, {capability: id, resource: object}, Tag);
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
 * names the proof tag, the `Grant` type, and the discharge verb from the one
 * declaration. The proof is discharged with the canonical `Grant.provide(grant)`.
 */
export const Capability = {
	Class: makeClass,
	Level: makeLevel,
	Relation: makeRelation,
} as const;
