/**
 * `Relation` — the ReBAC primitive: a `(subject, relation, object)` tuple, and
 * the {@link RelationStore} port that answers whether a tuple exists (ADR 0107
 * §4/§5). This is the assigned, resource-scoped authority axis (`moderates`,
 * `admin`), deliberately asymmetric to the ordered `Level` axis.
 *
 * The port is **vocab-free and storage-blind**: it names no relation, no D1,
 * no tuple table. `features/kunye` provides `RelationStoreLive` over the
 * `relation_tuple` D1 table; this module only declares the question
 * (`has(tuple)`), and the relation discharge (`Capability.Relation.over`) walks
 * resource {@link ancestry} asking it once per ancestor.
 */
import {Context, type Effect} from "effect";
import type {Resource} from "./Resource.ts";

/** A `(subject, relation, object)` ReBAC tuple — the object is a resource node. */
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
	}
>()("authz/RelationStore") {}
