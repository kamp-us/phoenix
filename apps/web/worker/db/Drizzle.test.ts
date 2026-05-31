/**
 * Drizzle service contract tests — scope B (smoke, semantics, composition,
 * type inference, batch tuple shape).
 *
 * The `Drizzle` service is the trust boundary between every feature service
 * and D1. These tests verify the wrapper's promise → Effect conversion in
 * isolation — no workerd, no real D1. A fake `DrizzleDb` is sufficient
 * because the wrapper never inspects the builder, it just forwards it to the
 * caller's callback.
 *
 * Post-fbb57d8 reshape: `run` and `batch` are no longer Context-bound statics.
 * They are bound methods on the Tag's value (`DrizzleAccess`). Tests
 * destructure them at the top of each Effect.gen, mirroring the production
 * service idiom (`const {run, batch} = yield* Drizzle`).
 *
 * Integration coverage (real D1 via miniflare) lives in the per-feature
 * integration tests under `tests/integration/`.
 */
import {assert, describe, it} from "@effect/vitest";
import {eq} from "drizzle-orm";
import type {BatchItem} from "drizzle-orm/batch";
import {Cause, Effect, Exit, Layer, Option} from "effect";
import {makeSqliteD1} from "../features/fate/__support__/sqlite-d1";
import {
	createDrizzle,
	Drizzle,
	type DrizzleAccess,
	type DrizzleDb,
	DrizzleError,
	makeDrizzleAccess,
} from "./Drizzle";
import baselineMigration from "./drizzle/migrations/0000_d1_baseline.sql?raw";
import * as schema from "./drizzle/schema";

/**
 * A fake `DrizzleDb` instance — the wrapper passes it to the callback
 * untouched, so any sentinel value works. Tests that need to spy on the
 * builder check identity against this.
 */
// biome-ignore lint/plugin: `DrizzleDb` is a fully-typed drizzle client that can't be structurally constructed in a fake; the wrapper passes this sentinel through untouched.
const FAKE_DB = {__phoenix_test_db__: true} as unknown as DrizzleDb;

/**
 * Build a `DrizzleAccess` value over a given fake `DrizzleDb`. Delegates to the
 * production {@link makeDrizzleAccess} so the contract tests exercise the real
 * `run` / `batch` bodies, while letting each test supply its own `db` (so
 * `batch` spy tests can intercept `db.batch(...)`).
 */
const makeAccess = (db: DrizzleDb): DrizzleAccess => makeDrizzleAccess(db);

/**
 * Test layer that provides the fake builder as the `Drizzle` service. The real
 * worker-level layer (`makeDrizzleLayer`) wraps a `drizzle(env.PHOENIX_DB,
 * {...})` instance which requires a workerd D1 binding; the contract under test
 * is the `run` / `batch` wrapping, not the builder construction.
 */
const TestDrizzleLayer = Layer.succeed(Drizzle, makeAccess(FAKE_DB));

/**
 * Stand-in `BatchItem<"sqlite">` value. The real `BatchItem` is a
 * `RunnableQuery` — we can't construct one without a live drizzle builder, so
 * we mint sentinels with `as unknown as BatchItem<"sqlite">`. This keeps the
 * tuple shape concrete (so `T extends Readonly<[U, ...U[]]>` infers a real
 * length-typed tuple instead of collapsing to `never`).
 */
const fakeStmt = (id: number) =>
	// biome-ignore lint/plugin: `BatchItem` is an opaque `RunnableQuery` that can't be built without a live drizzle builder; this sentinel keeps the tuple shape concrete (see the doc comment above).
	({__stmt__: id, _: {result: {rowsAffected: id}}}) as unknown as BatchItem<"sqlite">;

describe("Drizzle.run", () => {
	it.effect("smoke: callback success → typed value flows through", () =>
		Effect.gen(function* () {
			const {run} = yield* Drizzle;
			const result = yield* run(() => Promise.resolve(42));
			assert.strictEqual(result, 42);
		}).pipe(Effect.provide(TestDrizzleLayer)),
	);

	it.effect("passes the live drizzle builder to the callback", () =>
		Effect.gen(function* () {
			const {run} = yield* Drizzle;
			const received = yield* run((db) => Promise.resolve(db));
			assert.strictEqual(received, FAKE_DB);
		}).pipe(Effect.provide(TestDrizzleLayer)),
	);

	it.effect("semantics: rejection → DrizzleError with preserved cause", () =>
		Effect.gen(function* () {
			const {run} = yield* Drizzle;
			const boom = new Error("d1 query failed");
			const exit = yield* Effect.exit(run(() => Promise.reject(boom)));

			assert.isTrue(Exit.isFailure(exit), "expected failure");
			if (Exit.isSuccess(exit)) return;

			const errOpt = Cause.findErrorOption(exit.cause);
			assert.isTrue(Option.isSome(errOpt), "expected failure carries a typed error");
			const err = Option.getOrThrow(errOpt);
			assert.strictEqual(err._tag, "@phoenix/Drizzle/Error");
			assert.instanceOf(err, DrizzleError);
			assert.strictEqual((err as DrizzleError).cause, boom);
		}).pipe(Effect.provide(TestDrizzleLayer)),
	);

	it.effect("composition: Effect.all over multiple run calls", () =>
		Effect.gen(function* () {
			const {run} = yield* Drizzle;
			const results = yield* Effect.all([
				run(() => Promise.resolve("a")),
				run(() => Promise.resolve("b")),
				run(() => Promise.resolve("c")),
			]);
			assert.deepStrictEqual(results, ["a", "b", "c"]);
		}).pipe(Effect.provide(TestDrizzleLayer)),
	);

	it.effect("type inference: callback's promised type is the Effect's success type", () =>
		// Compile-time assertion via a typed binding. If `run` widened the
		// return to `unknown`, the assignment to `number` would fail tsc.
		Effect.gen(function* () {
			const {run} = yield* Drizzle;
			const n: number = yield* run(() => Promise.resolve(7));
			const s: string = yield* run(() => Promise.resolve("hello"));
			const obj: {id: string} = yield* run(() => Promise.resolve({id: "x"}));
			assert.strictEqual(n + s.length + obj.id.length, 7 + 5 + 1);
		}).pipe(Effect.provide(TestDrizzleLayer)),
	);
});

describe("Drizzle.batch", () => {
	/**
	 * `batch` ultimately calls `db.batch(statements)` and trusts D1 / drizzle
	 * to execute them atomically. With a fake builder we stub `batch` to
	 * return a sentinel so the wrapping behavior is observable.
	 */
	function makeBatchSpy() {
		const calls: Array<readonly unknown[]> = [];
		// biome-ignore lint/plugin: spy fake — `DrizzleDb` is a fully-typed drizzle client that can't be structurally built; only `db.batch` is exercised here.
		const db = {
			batch(statements: readonly unknown[]) {
				calls.push(statements);
				return Promise.resolve(statements.map((_, i) => ({rowsAffected: i + 1})));
			},
		} as unknown as DrizzleDb;
		const layer = Layer.succeed(Drizzle, makeAccess(db));
		return {db, calls, layer};
	}

	it.effect("smoke: forwards the tuple to db.batch and returns its result", () => {
		const {calls, layer} = makeBatchSpy();
		return Effect.gen(function* () {
			const {batch} = yield* Drizzle;
			const stmts = [fakeStmt(1), fakeStmt(2)] as const;
			const result = yield* batch(() => stmts);

			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0], stmts);
			assert.deepStrictEqual(result, [{rowsAffected: 1}, {rowsAffected: 2}]);
		}).pipe(Effect.provide(layer));
	});

	it.effect("batch tuple shape: callback returns the tuple, result mirrors length", () => {
		const {layer} = makeBatchSpy();
		return Effect.gen(function* () {
			const {batch} = yield* Drizzle;
			const single = yield* batch(() => [fakeStmt(1)] as const);
			assert.strictEqual(single.length, 1);

			const triple = yield* batch(() => [fakeStmt(1), fakeStmt(2), fakeStmt(3)] as const);
			assert.strictEqual(triple.length, 3);
		}).pipe(Effect.provide(layer));
	});

	it.effect("semantics: rejection → DrizzleError", () => {
		const boom = new Error("batch failed");
		// biome-ignore lint/plugin: spy fake — `DrizzleDb` is a fully-typed drizzle client that can't be structurally built; only `db.batch` is exercised here.
		const db = {
			batch: () => Promise.reject(boom),
		} as unknown as DrizzleDb;
		const layer = Layer.succeed(Drizzle, makeAccess(db));
		return Effect.gen(function* () {
			const {batch} = yield* Drizzle;
			const exit = yield* Effect.exit(batch(() => [fakeStmt(1)] as const));
			assert.isTrue(Exit.isFailure(exit), "expected failure");
			if (Exit.isSuccess(exit)) return;
			const err = Option.getOrThrow(Cause.findErrorOption(exit.cause));
			assert.strictEqual(err._tag, "@phoenix/Drizzle/Error");
			assert.strictEqual((err as DrizzleError).cause, boom);
		}).pipe(Effect.provide(layer));
	});
});

describe("makeDrizzleAccess (extracted factory)", () => {
	it.effect("run: closes over the given db and flows the value through", () =>
		Effect.gen(function* () {
			const {run} = makeDrizzleAccess(FAKE_DB);
			const received = yield* run((db) => Promise.resolve(db));
			assert.strictEqual(received, FAKE_DB);
		}),
	);

	it.effect("run: rejection → DrizzleError with preserved cause", () =>
		Effect.gen(function* () {
			const {run} = makeDrizzleAccess(FAKE_DB);
			const boom = new Error("run failed");
			const exit = yield* Effect.exit(run(() => Promise.reject(boom)));
			assert.isTrue(Exit.isFailure(exit), "expected failure");
			if (Exit.isSuccess(exit)) return;
			const err = Option.getOrThrow(Cause.findErrorOption(exit.cause));
			assert.instanceOf(err, DrizzleError);
			assert.strictEqual((err as DrizzleError).cause, boom);
		}),
	);

	it.effect("batch: forwards the tuple to db.batch and returns its result", () => {
		const calls: Array<readonly unknown[]> = [];
		// biome-ignore lint/plugin: spy fake — `DrizzleDb` is a fully-typed drizzle client that can't be structurally built; only `db.batch` is exercised here.
		const db = {
			batch(statements: readonly unknown[]) {
				calls.push(statements);
				return Promise.resolve(statements.map((_, i) => ({rowsAffected: i + 1})));
			},
		} as unknown as DrizzleDb;
		return Effect.gen(function* () {
			const {batch} = makeDrizzleAccess(db);
			const stmts = [fakeStmt(1), fakeStmt(2)] as const;
			const result = yield* batch(() => stmts);
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0], stmts);
			assert.deepStrictEqual(result, [{rowsAffected: 1}, {rowsAffected: 2}]);
		});
	});

	it.effect("batch: rejection → DrizzleError", () => {
		const boom = new Error("batch failed");
		// biome-ignore lint/plugin: spy fake — `DrizzleDb` is a fully-typed drizzle client that can't be structurally built; only `db.batch` is exercised here.
		const db = {
			batch: () => Promise.reject(boom),
		} as unknown as DrizzleDb;
		return Effect.gen(function* () {
			const {batch} = makeDrizzleAccess(db);
			const exit = yield* Effect.exit(batch(() => [fakeStmt(1)] as const));
			assert.isTrue(Exit.isFailure(exit), "expected failure");
			if (Exit.isSuccess(exit)) return;
			const err = Option.getOrThrow(Cause.findErrorOption(exit.cause));
			assert.strictEqual((err as DrizzleError).cause, boom);
		});
	});
});

/**
 * Generic `batch` atomicity over a REAL SQL engine (the `node:sqlite`-backed D1
 * fake): a `batch([...])` either commits the whole tuple or none of it. The spy
 * tests above prove error propagation; this proves there's no PARTIAL write when
 * one statement in the tuple fails. The vote-specific end-to-end invariant
 * (`Vote.cast` rolling back a real vote+score+mirror+karma tuple) has its own
 * test in `worker/features/vote/Vote.test.ts`.
 */
describe("Drizzle.batch atomicity (real SQLite via the D1 fake)", () => {
	const now = new Date();

	it.effect("a mid-batch failure rolls back the whole tuple — no partial write", () => {
		const sqlite = makeSqliteD1();
		sqlite.applyMigration(baselineMigration);
		const db = createDrizzle(sqlite.d1);
		const layer = Layer.succeed(Drizzle, makeDrizzleAccess(db));

		return Effect.gen(function* () {
			const {run, batch} = yield* Drizzle;

			// A pre-existing vote row. The batch below tries to insert a DIFFERENT
			// valid row plus a DUPLICATE of this one — the duplicate violates the
			// `(definition_id, voter_id)` PK, failing the batch mid-tuple.
			yield* run((d) =>
				d
					.insert(schema.definitionVote)
					.values({definitionId: "def-1", voterId: "voter-existing", createdAt: now})
					.run(),
			);

			const exit = yield* Effect.exit(
				batch((d) => [
					d
						.insert(schema.definitionVote)
						.values({definitionId: "def-1", voterId: "voter-new", createdAt: now}),
					// PK collision with the pre-existing row → mid-batch failure.
					d
						.insert(schema.definitionVote)
						.values({definitionId: "def-1", voterId: "voter-existing", createdAt: now}),
				]),
			);
			assert.isTrue(Exit.isFailure(exit), "the duplicate-PK batch must fail");

			// The first (valid) insert in the failed batch must NOT have landed:
			// only the pre-existing `voter-existing` row remains.
			const rows = yield* run((d) =>
				d
					.select()
					.from(schema.definitionVote)
					.where(eq(schema.definitionVote.definitionId, "def-1")),
			);
			assert.strictEqual(rows.length, 1, "no partial write: only the pre-existing row survives");
			assert.strictEqual(rows[0]!.voterId, "voter-existing");

			sqlite.close();
		}).pipe(Effect.provide(layer));
	});
});
