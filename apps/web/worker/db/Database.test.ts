/**
 * `Database` service contract tests (T1 infra — ADR 0040 b1 addendum).
 *
 * `Database` is the single seam holding the raw `D1Database` handle. Both the
 * `Drizzle` service and the better-auth adapter derive from it, so providing one
 * `Database` layer guarantees they share one underlying handle (the
 * one-`sqlite` invariant is type-enforced by the layer graph, not test-owned).
 *
 * These tests cover the **test-side** layer only: `makeDatabaseTest()` builds a
 * fresh in-memory handle (the `node:sqlite`-backed D1 fake) wrapped in
 * `Effect.acquireRelease`, so the handle closes on scope teardown.
 * `DatabaseLive` (the production layer sourcing the handle from the `PhoenixDb`
 * binding) is exercised by the worker/integration tiers, not here — it would
 * require a workerd D1 binding.
 */
import {assert, describe, it} from "@effect/vitest";
import {eq} from "drizzle-orm";
import {Effect} from "effect";
import {Database, makeDatabaseTest} from "./Database";
import {createDrizzle} from "./Drizzle";
import * as schema from "./drizzle/schema";

describe("makeDatabaseTest", () => {
	it.effect("resolves the Database tag to a raw D1Database value", () =>
		Effect.gen(function* () {
			const db = yield* Database;
			// The raw D1 surface drizzle-orm/d1 exercises — `prepare`/`batch`/`exec`.
			assert.isFunction(db.prepare);
			assert.isFunction(db.batch);
			assert.isFunction(db.exec);
		}).pipe(Effect.provide(makeDatabaseTest())),
	);

	it.effect("reads and writes through the resolved handle", () =>
		Effect.gen(function* () {
			const raw = yield* Database;
			const db = createDrizzle(raw);
			const now = new Date();

			yield* Effect.promise(() =>
				db
					.insert(schema.definitionVote)
					.values({definitionId: "def-1", voterId: "voter-1", createdAt: now})
					.run(),
			);

			const rows = yield* Effect.promise(() =>
				db
					.select()
					.from(schema.definitionVote)
					.where(eq(schema.definitionVote.definitionId, "def-1")),
			);

			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.voterId, "voter-1");
		}).pipe(Effect.provide(makeDatabaseTest())),
	);

	it.effect("each call yields an independent fresh handle (no cross-contamination)", () =>
		Effect.gen(function* () {
			// Write into one Database scope.
			yield* Effect.gen(function* () {
				const db = createDrizzle(yield* Database);
				yield* Effect.promise(() =>
					db
						.insert(schema.definitionVote)
						.values({definitionId: "def-1", voterId: "voter-1", createdAt: new Date()})
						.run(),
				);
			}).pipe(Effect.provide(makeDatabaseTest()));

			// A second, independent Database must not see the first's row.
			yield* Effect.gen(function* () {
				const db = createDrizzle(yield* Database);
				const rows = yield* Effect.promise(() => db.select().from(schema.definitionVote));
				assert.strictEqual(rows.length, 0, "a fresh handle starts empty");
			}).pipe(Effect.provide(makeDatabaseTest()));
		}),
	);

	it.effect("registers a finalizer that closes the handle after the scope ends", () =>
		Effect.gen(function* () {
			// Drive a scope to completion, capturing the resolved handle, then assert
			// the handle is closed once the scope (and its finalizer) has run.
			let raw!: D1Database;
			yield* Effect.gen(function* () {
				raw = yield* Database;
			}).pipe(Effect.provide(makeDatabaseTest()));

			// The fake's `close()` calls `node:sqlite`'s `DatabaseSync.close()`; a
			// subsequent statement against a closed handle rejects. If the finalizer
			// did NOT run, this `prepare(...).run()` would succeed.
			const exit = yield* Effect.exit(Effect.promise(() => raw.prepare("SELECT 1").run()));
			assert.isTrue(exit._tag === "Failure", "the handle must be closed after the scope ends");
		}),
	);
});
