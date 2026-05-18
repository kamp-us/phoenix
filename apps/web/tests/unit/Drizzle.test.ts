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
 * Integration coverage (real D1 via miniflare) lives in the per-feature
 * integration tests under `tests/integration/`.
 */
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Layer, Option} from "effect";
import {Drizzle, type DrizzleDb, DrizzleError} from "../../worker/services/Drizzle";

/**
 * A fake `DrizzleDb` instance — the wrapper passes it to the callback
 * untouched, so any sentinel value works. Tests that need to spy on the
 * builder check identity against this.
 */
const FAKE_DB = {__phoenix_test_db__: true} as unknown as DrizzleDb;

/**
 * Test layer that provides the fake builder as the `Drizzle` service. Real
 * `DrizzleLive` would call `drizzle(env.PHOENIX_DB, {...})` which requires
 * a workerd D1 binding; the contract under test is the `run` / `batch`
 * wrapping, not the builder construction.
 */
const TestDrizzleLayer = Layer.succeed(Drizzle, FAKE_DB);

describe("Drizzle.run", () => {
	it.effect("smoke: callback success → typed value flows through", () =>
		Effect.gen(function* () {
			const result = yield* Drizzle.run(() => Promise.resolve(42));
			assert.strictEqual(result, 42);
		}).pipe(Effect.provide(TestDrizzleLayer)),
	);

	it.effect("passes the live drizzle builder to the callback", () =>
		Effect.gen(function* () {
			const received = yield* Drizzle.run((db) => Promise.resolve(db));
			assert.strictEqual(received, FAKE_DB);
		}).pipe(Effect.provide(TestDrizzleLayer)),
	);

	it.effect("semantics: rejection → DrizzleError with preserved cause", () =>
		Effect.gen(function* () {
			const boom = new Error("d1 query failed");
			const exit = yield* Effect.exit(Drizzle.run(() => Promise.reject(boom)));

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

	it.effect("composition: Effect.all over multiple Drizzle.run calls", () =>
		Effect.gen(function* () {
			const results = yield* Effect.all([
				Drizzle.run(() => Promise.resolve("a")),
				Drizzle.run(() => Promise.resolve("b")),
				Drizzle.run(() => Promise.resolve("c")),
			]);
			assert.deepStrictEqual(results, ["a", "b", "c"]);
		}).pipe(Effect.provide(TestDrizzleLayer)),
	);

	it.effect("type inference: callback's promised type is the Effect's success type", () =>
		// Compile-time assertion via a typed binding. If `Drizzle.run` widened
		// the return to `unknown`, the assignment to `number` would fail tsc.
		Effect.gen(function* () {
			const n: number = yield* Drizzle.run(() => Promise.resolve(7));
			const s: string = yield* Drizzle.run(() => Promise.resolve("hello"));
			const obj: {id: string} = yield* Drizzle.run(() => Promise.resolve({id: "x"}));
			assert.strictEqual(n + s.length + obj.id.length, 7 + 5 + 1);
		}).pipe(Effect.provide(TestDrizzleLayer)),
	);
});

describe("Drizzle.batch", () => {
	/**
	 * `Drizzle.batch` ultimately calls `db.batch(statements)` and trusts D1 /
	 * drizzle to execute them atomically. With a fake builder we stub
	 * `batch` to return a sentinel so the wrapping behavior is observable.
	 */
	function makeBatchSpy() {
		const calls: Array<readonly unknown[]> = [];
		const db = {
			batch(statements: readonly unknown[]) {
				calls.push(statements);
				return Promise.resolve(statements.map((_, i) => ({rowsAffected: i + 1})));
			},
		} as unknown as DrizzleDb;
		const layer = Layer.succeed(Drizzle, db);
		return {db, calls, layer};
	}

	it.effect("smoke: forwards the tuple to db.batch and returns its result", () => {
		const {calls, layer} = makeBatchSpy();
		return Effect.gen(function* () {
			const stmts = [{__stmt__: 1}, {__stmt__: 2}] as const;
			const result = yield* Drizzle.batch(() => stmts as never);

			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0], stmts);
			assert.deepStrictEqual(result, [{rowsAffected: 1}, {rowsAffected: 2}]);
		}).pipe(Effect.provide(layer));
	});

	it.effect("batch tuple shape: callback returns the tuple, result mirrors length", () => {
		const {layer} = makeBatchSpy();
		return Effect.gen(function* () {
			const single = yield* Drizzle.batch(() => [{__stmt__: 1}] as never);
			assert.strictEqual(single.length, 1);

			const triple = yield* Drizzle.batch(
				() => [{__stmt__: 1}, {__stmt__: 2}, {__stmt__: 3}] as never,
			);
			assert.strictEqual(triple.length, 3);
		}).pipe(Effect.provide(layer));
	});

	it.effect("semantics: rejection → DrizzleError", () => {
		const boom = new Error("batch failed");
		const db = {
			batch: () => Promise.reject(boom),
		} as unknown as DrizzleDb;
		const layer = Layer.succeed(Drizzle, db);
		return Effect.gen(function* () {
			const exit = yield* Effect.exit(Drizzle.batch(() => [{__stmt__: 1}] as never));
			assert.isTrue(Exit.isFailure(exit), "expected failure");
			if (Exit.isSuccess(exit)) return;
			const err = Option.getOrThrow(Cause.findErrorOption(exit.cause));
			assert.strictEqual(err._tag, "@phoenix/Drizzle/Error");
			assert.strictEqual((err as DrizzleError).cause, boom);
		}).pipe(Effect.provide(layer));
	});
});
