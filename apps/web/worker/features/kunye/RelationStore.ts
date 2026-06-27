/**
 * `RelationStoreLive` — the D1 adapter for `@kampus/authz`'s `RelationStore` port,
 * answering the ReBAC existence question over the `relation_tuple` table (ADR 0107).
 *
 * The port declares only `has`: the tuple's presence IS the grant, and there is no
 * runtime write path — tuples are minted offline (`@kampus/founder-seed`), the same
 * fail-closed shape `user.role` had.
 */
import {RelationStore, type Resource} from "@kampus/authz";
import {and, eq} from "drizzle-orm";
import {Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";

/** The `relation_tuple.object` key for a resource node — its `(type, id)` pair. */
export const objectKey = (object: Resource): string => `${object.type}:${object.id}`;

export const RelationStoreLive = Layer.effect(RelationStore)(
	Effect.gen(function* () {
		const {run} = orDieAccess(yield* Drizzle);
		return {
			has: Effect.fn("RelationStore.has")(function* (tuple) {
				const row = yield* run((db) =>
					db
						.select({subject: schema.relationTuple.subject})
						.from(schema.relationTuple)
						.where(
							and(
								eq(schema.relationTuple.subject, tuple.subject),
								eq(schema.relationTuple.relation, tuple.relation),
								eq(schema.relationTuple.object, objectKey(tuple.object)),
							),
						)
						.limit(1)
						.get(),
				);
				return row !== undefined;
			}),
		};
	}),
);
