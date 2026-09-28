/**
 * `RelationStoreLive` unit coverage — the port-contract decisions that hold with no database
 * (ADR 0082), with the `Drizzle` seam substituted directly. Whether the WHERE actually resolves
 * the composite-PK existence against real D1 is the integration tier's job
 * (`tests/integration/kunye-relation-store.test.ts`).
 */

import {assert, describe, it} from "@effect/vitest";
import {RelationStore, resource} from "@kampus/authz";
import {Effect, Layer} from "effect";
import {
	createDrizzle,
	Drizzle,
	type DrizzleAccess,
	type DrizzleDb,
	makeDrizzleAccess,
} from "../../db/Drizzle.ts";
import {RelationStoreLive} from "./RelationStore.ts";

// Returns the queued result verbatim (the callback is never invoked, so no engine is needed)
// and counts calls — the counter pins the fresh-per-call read.
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

// Drives the production statement through a real drizzle client over a D1 that records
// what it is asked to prepare and bind, and answers every read with no rows.
function capturingAccess(): {
	access: DrizzleAccess;
	statement: () => {sql: string; params: unknown[]};
} {
	const captured: {sql: string; params: unknown[]}[] = [];
	// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed in a fake; this records the prepared SQL/params, nothing executes.
	const recordingD1 = {
		prepare(sql: string) {
			const entry = {sql, params: [] as unknown[]};
			captured.push(entry);
			return {
				bind(...p: unknown[]) {
					entry.params.push(...p);
					return this;
				},
				all: async () => ({results: []}),
				first: async () => null,
				run: async () => ({}),
				raw: async () => [],
			};
		},
	} as unknown as D1Database;
	return {
		access: makeDrizzleAccess(createDrizzle(recordingD1)),
		statement: () => {
			assert.strictEqual(captured.length, 1, "exactly one statement reached the D1 binding");
			const [only] = captured;
			if (only === undefined) throw new Error("no statement reached the D1 binding");
			return only;
		},
	};
}

const storeLayer = (access: DrizzleAccess) =>
	RelationStoreLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

const platform = resource("platform", "kampus");

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

	it.effect("compiles to one IN-list read over relation_tuple (statement pin, no engine)", () =>
		Effect.gen(function* () {
			const {access, statement} = capturingAccess();
			yield* Effect.gen(function* () {
				const store = yield* RelationStore;
				yield* store.hasSubjects({subjects: ["u1", "u2"], relation: "moderates", object: platform});
			}).pipe(Effect.provide(storeLayer(access)));
			const {sql, params} = statement();
			assert.match(sql, /from "relation_tuple"/i);
			assert.match(sql, /"subject" in \(\?, \?\)/i);
			assert.match(sql, /"relation" = \?/i);
			assert.match(sql, /"object" = \?/i);
			assert.includeMembers(params, ["u1", "u2", "moderates", "platform:kampus"]);
		}),
	);
});

describe("RelationStore.subjectsOf — the open-set enumeration for one (relation, object) (#1699)", () => {
	it.effect("returns every subject the read rows carry", () =>
		Effect.gen(function* () {
			const store = yield* RelationStore;
			const mods = yield* store.subjectsOf({relation: "moderates", object: platform});
			assert.deepStrictEqual([...mods].sort(), ["u-mod-a", "u-mod-b"]);
		}).pipe(
			Effect.provide(
				storeLayer(countingAccess([{subject: "u-mod-a"}, {subject: "u-mod-b"}]).access),
			),
		),
	);

	it.effect(
		"compiles to a relation/object-filtered read over relation_tuple (statement pin, no engine)",
		() =>
			Effect.gen(function* () {
				const {access, statement} = capturingAccess();
				yield* Effect.gen(function* () {
					const store = yield* RelationStore;
					yield* store.subjectsOf({relation: "moderates", object: platform});
				}).pipe(Effect.provide(storeLayer(access)));
				const {sql, params} = statement();
				assert.match(sql, /from "relation_tuple"/i);
				assert.match(sql, /"relation" = \?/i);
				assert.match(sql, /"object" = \?/i);
				// No subject predicate — the enumeration is the whole set for this (relation, object).
				assert.notMatch(sql, /"subject" (=|in)/i);
				assert.includeMembers(params, ["moderates", "platform:kampus"]);
			}),
	);
});

describe("RelationStore.has — query shape (statement pin, no engine)", () => {
	it.effect("filters subject/relation/object on relation_tuple, limit 1", () =>
		Effect.gen(function* () {
			const {access, statement} = capturingAccess();
			yield* Effect.gen(function* () {
				const store = yield* RelationStore;
				yield* store.has({subject: "u-alice", relation: "moderates", object: platform});
			}).pipe(Effect.provide(storeLayer(access)));
			const {sql, params} = statement();
			assert.match(sql, /from "relation_tuple"/i);
			assert.match(sql, /"subject" = \?/i);
			assert.match(sql, /"relation" = \?/i);
			assert.match(sql, /"object" = \?/i);
			assert.match(sql, /limit \?/i);
			assert.includeMembers(params, ["u-alice", "moderates", "platform:kampus"]);
		}),
	);
});
