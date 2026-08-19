/**
 * `Relation` — the ReBAC primitive: a `(subject, relation, object)` tuple, and
 * the {@link RelationStore} port answering whether a tuple exists (ADR 0107
 * §4/§5). The assigned, resource-scoped authority axis (`moderates`, `admin`),
 * asymmetric to the ordered `Level` axis. Storage-blind: `features/kunye`
 * provides `RelationStoreLive` over the `relation_tuple` D1 table; this module
 * only declares `has(tuple)`, and the discharge walks resource {@link ancestry}
 * asking it once per ancestor.
 */
import {Context, type Effect} from "effect";
import type {Resource} from "./Resource.ts";

export interface Relation {
	readonly subject: string;
	readonly relation: string;
	readonly object: Resource;
}

/**
 * The port answering whether a single relation tuple exists. Checked **fresh on
 * each call** by design (ADR 0098/0107): a revoked tuple denies the next call
 * with no session to invalidate. The adapter Layer lives in `features/kunye`.
 */
export class RelationStore extends Context.Service<
	RelationStore,
	{
		readonly has: (tuple: Relation) => Effect.Effect<boolean>;

		// The batched form of {@link has}: ONE store read instead of N per-subject calls, so a
		// membership join is a single round-trip, not an in-batch N+1. Same direct-tuple semantics
		// as `has` — no ancestry walk.
		readonly hasSubjects: (query: {
			readonly subjects: ReadonlyArray<string>;
			readonly relation: string;
			readonly object: Resource;
		}) => Effect.Effect<ReadonlySet<string>>;

		// The open-set read `has`/`hasSubjects` can't answer, because both need candidate ids up
		// front: a mod fan-out (#1699) has none — the recipient set IS who holds the tuple. Same
		// direct-tuple semantics as `has` — no ancestry walk.
		readonly subjectsOf: (query: {
			readonly relation: string;
			readonly object: Resource;
		}) => Effect.Effect<ReadonlySet<string>>;
	}
>()("authz/RelationStore") {}
