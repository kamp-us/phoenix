/**
 * `@kampus/authz` — the vocab-free capability-as-Effect authorization mechanism
 * (ADR 0107). Names no kamp.us noun, no fate, no D1: primitives, the sealed
 * {@link Grant}, the {@link Capability} class-builders, and the
 * {@link CurrentActor}/{@link RelationStore}/{@link AgentAuthority} ports. The
 * kamp.us instances + `*Live` adapter Layers live in `features/kunye`.
 *
 * Deliberate omission: {@link Grant}'s constructor (`mint`) is NOT re-exported —
 * only the `Grant` *type* escapes, so a consumer can hold a proof but never
 * fabricate one (the seal, ADR 0107 §1).
 */
export {
	type Actor,
	type Agent,
	type Authenticated,
	agent,
	type Human,
	human,
	matchActor,
	type Principal,
	type Unauthenticated,
	unauthenticated,
} from "./Actor.ts";
export {AgentAuthority, type AgentAuthorityRequest} from "./AgentAuthority.ts";
export {
	Capability,
	type CapabilityTag,
	type ClassCapability,
	type ClassConfig,
	type LevelCapability,
	type LevelConfig,
	type RelationCapability,
	type RelationConfig,
} from "./Capability.ts";
export {CurrentActor} from "./CurrentActor.ts";
// `Grant` (the type) and `isGrant` escape; `mint` does NOT — the seal.
export {type Grant, type GrantScope, isGrant} from "./Grant.ts";
export {Scale} from "./Level.ts";
export {type Relation, RelationStore} from "./Relation.ts";
export {ancestry, covers, type Resource, resource, sameNode} from "./Resource.ts";
