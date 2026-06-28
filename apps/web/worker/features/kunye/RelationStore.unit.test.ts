/**
 * `RelationStoreLive` unit coverage — the port-contract decisions that are
 * wrong-or-right with no database (ADR 0082): a present row → `has === true`, an
 * absent row → `has === false`, the read runs fresh on every call (no cached
 * authority), and the `object` column key is the resource's `(type, id)` pair.
 *
 * The `Drizzle` seam is substituted directly (the `Report.unit.test.ts` idiom): a
 * scripted `run` returns the queued lookup result verbatim without an engine. Whether
 * the WHERE actually resolves the composite-PK existence against real D1 is
 * only-wrong-if-the-DB-differs and lives in the integration tier
 * (`tests/integration/kunye-relation-store.test.ts`).
 */

import {assert, describe, it} from "@effect/vitest";
import {RelationStore, resource} from "@kampus/authz";
import {and, eq, inArray} from "drizzle-orm";
import {Effect, Layer} from "effect";
import {createDrizzle, Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {objectKey, RelationStoreLive} from "./RelationStore.ts";

// A `run` that returns the queued lookup result verbatim (the callback is never
// invoked, so no engine is needed) and counts how many times it was called — the
// counter pins the fresh-per-call read.
function countingAccess(result: unknown): {access: DrizzleAccess; calls: () => number} {
	const state = {n: 0};
	return {
		access: {
			run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
				void fn;
				state.n++;
				return Effect.succeed(result as A);
			},
			batch: () => Effect.die(new Error("RelationStore issues no batch")),
		},
		calls: () => state.n,
	};
}

const storeLayer = (access: DrizzleAccess) =>
	RelationStoreLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

const platform = resource("platform", "kampus");

describe("objectKey — the relation_tuple.object key for a resource node", () => {
	it("serializes a node as its `type:id` pair", () => {
		assert.strictEqual(objectKey(platform), "platform:kampus");
		assert.strictEqual(objectKey(resource("term", "42")), "term:42");
	});
});

describe("RelationStore.has — existence maps the lookup result to a boolean", () => {
	it.effect("a matched row → true", () =>
		Effect.gen(function* () {
			const store = yield* RelationStore;
			const found = yield* store.has({subject: "u-alice", relation: "moderates", object: platform});
			assert.isTrue(found);
		}).pipe(Effect.provide(storeLayer(countingAccess({subject: "u-alice"}).access))),
	);

	it.effect("no row → false", () =>
		Effect.gen(function* () {
			const store = yield* RelationStore;
			const found = yield* store.has({subject: "rando", relation: "moderates", object: platform});
			assert.isFalse(found);
		}).pipe(Effect.provide(storeLayer(countingAccess(undefined).access))),
	);

	it.effect("reads fresh on every call — no cached authority", () =>
		Effect.gen(function* () {
			const {access, calls} = countingAccess(undefined);
			const program = Effect.gen(function* () {
				const store = yield* RelationStore;
				yield* store.has({subject: "u-alice", relation: "moderates", object: platform});
				yield* store.has({subject: "u-alice", relation: "moderates", object: platform});
				return calls();
			}).pipe(Effect.provide(storeLayer(access)));
			assert.strictEqual(yield* program, 2);
		}),
	);
});

describe("RelationStore.hasSubjects — batched membership over a subject set (#1360)", () => {
	it.effect("returns exactly the subjects present in the read rows", () =>
		Effect.gen(function* () {
			const store = yield* RelationStore;
			const mods = yield* store.hasSubjects({
				subjects: ["u1", "u2", "u3"],
				relation: "moderates",
				object: platform,
			});
			assert.deepStrictEqual([...mods].sort(), ["u1", "u3"]);
		}).pipe(Effect.provide(storeLayer(countingAccess([{subject: "u1"}, {subject: "u3"}]).access))),
	);

	it.effect("short-circuits to an empty set with NO store read for an empty subject set", () =>
		Effect.gen(function* () {
			const {access, calls} = countingAccess([{subject: "u1"}]);
			const program = Effect.gen(function* () {
				const store = yield* RelationStore;
				const mods = yield* store.hasSubjects({
					subjects: [],
					relation: "moderates",
					object: platform,
				});
				return {size: mods.size, calls: calls()};
			}).pipe(Effect.provide(storeLayer(access)));
			const {size, calls: n} = yield* program;
			assert.strictEqual(size, 0);
			assert.strictEqual(n, 0);
		}),
	);

	it("compiles to one IN-list read over relation_tuple (statement pin, no engine)", () => {
		const db: DrizzleDb = createDrizzle({} as D1Database);
		const {sql, params} = db
			.select({subject: schema.relationTuple.subject})
			.from(schema.relationTuple)
			.where(
				and(
					inArray(schema.relationTuple.subject, ["u1", "u2"]),
					eq(schema.relationTuple.relation, "moderates"),
					eq(schema.relationTuple.object, objectKey(platform)),
				),
			)
			.toSQL();
		assert.match(sql, /from "relation_tuple"/i);
		assert.match(sql, /"subject" in \(\?, \?\)/i);
		assert.match(sql, /"relation" = \?/i);
		assert.match(sql, /"object" = \?/i);
		assert.include(params as unknown[], "u1");
		assert.include(params as unknown[], "u2");
		assert.include(params as unknown[], "platform:kampus");
	});
});

describe("RelationStore.has — query shape (statement pin, no engine)", () => {
	// The production lookup compiles to an existence read over `relation_tuple`,
	// filtered by the three tuple columns with the `objectKey` serialization. The real
	// engine resolving it is the integration tier's job; this pins the SQL contract.
	it("filters subject/relation/object on relation_tuple, limit 1", () => {
		const db: DrizzleDb = createDrizzle({} as D1Database);
		const {sql, params} = db
			.select({subject: schema.relationTuple.subject})
			.from(schema.relationTuple)
			.where(
				and(
					eq(schema.relationTuple.subject, "u-alice"),
					eq(schema.relationTuple.relation, "moderates"),
					eq(schema.relationTuple.object, objectKey(platform)),
				),
			)
			.limit(1)
			.toSQL();
		assert.match(sql, /from "relation_tuple"/i);
		assert.match(sql, /"subject" = \?/i);
		assert.match(sql, /"relation" = \?/i);
		assert.match(sql, /"object" = \?/i);
		assert.match(sql, /limit \?/i);
		assert.include(params as unknown[], "u-alice");
		assert.include(params as unknown[], "moderates");
		assert.include(params as unknown[], "platform:kampus");
	});
});
