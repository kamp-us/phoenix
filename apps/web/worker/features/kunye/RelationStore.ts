/**
 * `RelationStoreLive` — the D1 adapter for `@kampus/authz`'s `RelationStore` port,
 * answering the ReBAC existence question over the `relation_tuple` table (ADR 0107).
 *
 * The port declares only `has`: the tuple's presence IS the grant, and there is no
 * runtime write path — tuples are minted offline (`@kampus/founder-seed`), the same
 * fail-closed shape `user.role` had.
 */
import {key as objectKey, RelationStore} from "@kampus/authz";
import {and, eq, inArray} from "drizzle-orm";
import {Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";

// The `relation_tuple.object` key IS `@kampus/authz`'s canonical `key` — re-exported
// under the worker-side name so the integration seed and the store read encode the
// object identically to the offline mint (`@kampus/founder-seed`). One key, no
// divergence: a seeded tuple is found by a discharge over the same node.
export {objectKey};

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

			hasSubjects: Effect.fn("RelationStore.hasSubjects")(function* ({subjects, relation, object}) {
				if (subjects.length === 0) return new Set<string>();
				const rows = yield* run((db) =>
					db
						.select({subject: schema.relationTuple.subject})
						.from(schema.relationTuple)
						.where(
							and(
								inArray(schema.relationTuple.subject, [...subjects]),
								eq(schema.relationTuple.relation, relation),
								eq(schema.relationTuple.object, objectKey(object)),
							),
						)
						.all(),
				);
				return new Set(rows.map((row) => row.subject));
			}),
		};
	}),
);
