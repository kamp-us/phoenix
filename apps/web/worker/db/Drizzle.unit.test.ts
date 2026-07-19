/**
 * Drizzle service contract — the wrapper's promise → Effect conversion in pure
 * isolation: no workerd, no SQL engine (ADR 0082 `unit` tier). A fake `DrizzleDb`
 * and a `db.batch` spy suffice because the wrapper never inspects the builder, it
 * just forwards it; these tests are wrong only if the wrapper is wrong, never if a
 * database differs.
 *
 * The generic `db.batch` atomicity-rollback property ("a mid-batch failure rolls
 * back the whole tuple — no partial write") used to live here over the banned
 * `node:sqlite` fake. It is a real-D1 fidelity fact, but it has no
 * integration-reachable surface: the integration tier is black-box HTTP over the
 * deployed worker (no in-process `db.batch` handle), and no fate mutation has a
 * reachable mid-batch fault (every `Vote.cast` batch statement is
 * collision-tolerant by construction). So it is a tracked, accepted irreducible —
 * see #614 — not satisfied by inventing a non-production fault-injection mutation.
 */
import {assert, describe, it} from "@effect/vitest";
import type {BatchItem} from "drizzle-orm/batch";
import {Cause, Effect, Exit, Layer, Option} from "effect";
import {
	Drizzle,
	type DrizzleAccess,
	type DrizzleDb,
	DrizzleError,
	makeDrizzleAccess,
} from "./Drizzle";

// biome-ignore lint/plugin: `DrizzleDb` is a fully-typed drizzle client that can't be structurally constructed in a fake; the wrapper passes this sentinel through untouched.
const FAKE_DB = {__phoenix_test_db__: true} as unknown as DrizzleDb;

/**
 * Delegates to the production {@link makeDrizzleAccess} so the tests exercise the
 * real `run` / `batch` bodies, while letting each test supply its own `db`.
 */
const makeAccess = (db: DrizzleDb): DrizzleAccess => makeDrizzleAccess(db);

const TestDrizzleLayer = Layer.succeed(Drizzle, makeAccess(FAKE_DB));

/**
 * Sentinel `BatchItem<"sqlite">`: the real one is an opaque `RunnableQuery` that
 * can't be built without a live builder. Keeps the tuple shape concrete so
 * `T extends Readonly<[U, ...U[]]>` infers a length-typed tuple, not `never`.
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
			assert.strictEqual(err._tag, "@kampus/Drizzle/Error");
			assert.instanceOf(err, DrizzleError);
			assert.strictEqual((err as DrizzleError).cause, boom);
		}).pipe(Effect.provide(TestDrizzleLayer)),
	);

	it.effect("composition: Effect.all over multiple run calls", () =>
		Effect.gen(function* () {
			const {run} = yield* Drizzle;
			const results = yield* Effect.all(
				[
					run(() => Promise.resolve("a")),
					run(() => Promise.resolve("b")),
					run(() => Promise.resolve("c")),
				],
				{concurrency: 1},
			);
			assert.deepStrictEqual(results, ["a", "b", "c"]);
		}).pipe(Effect.provide(TestDrizzleLayer)),
	);

	it.effect("type inference: callback's promised type is the Effect's success type", () =>
		// Compile-time assertion: if `run` widened the return to `unknown`, these
		// typed bindings would fail tsc.
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
	// Stubs `db.batch` to record its calls and return a sentinel, so the
	// wrapper's forwarding behavior is observable.
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
			assert.strictEqual(err._tag, "@kampus/Drizzle/Error");
			assert.strictEqual((err as DrizzleError).cause, boom);
		}).pipe(Effect.provide(layer));
	});
});
