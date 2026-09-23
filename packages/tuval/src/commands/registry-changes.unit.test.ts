import {assert, it} from "@effect/vitest";
import {Deferred, Effect, Fiber, Schema, Stream} from "effect";
import {buildRegistry, SpellRegistry} from "./registry.ts";
import {defineSpell} from "./spell.ts";
import {SpellSet} from "./spell-set.ts";

const spell = (name: string) =>
	defineSpell({
		path: [name],
		describe: name,
		params: Schema.Struct({}),
		result: Schema.Void,
		execute: () => Effect.void,
		capabilities: [],
	});

it.effect("a standalone registry streams its current descriptions and whole replacements", () =>
	Effect.gen(function* () {
		const registry = yield* SpellRegistry;
		const ready = yield* Deferred.make<void>();
		const observed = yield* registry.changes.pipe(
			Stream.tap(() => Deferred.succeed(ready, undefined)),
			Stream.take(2),
			Stream.runCollect,
			Effect.forkChild,
		);
		yield* Deferred.await(ready);
		yield* registry.swap(yield* buildRegistry({core: [spell("after")], programs: []}));
		const descriptions = yield* Fiber.join(observed);
		assert.deepStrictEqual(
			descriptions.map((rows) => rows.map((row) => row.path)),
			[[["before"]], [["after"]]],
		);
	}).pipe(Effect.provide(SpellRegistry.scripted([spell("before")]))),
);

it.effect(
	"the shared registry publishes committed reloads and retains descriptions on rejection",
	() =>
		Effect.gen(function* () {
			const registry = yield* SpellRegistry;
			const set = yield* SpellSet;
			const ready = yield* Deferred.make<void>();
			const observed = yield* registry.changes.pipe(
				Stream.tap(() => Deferred.succeed(ready, undefined)),
				Stream.take(2),
				Stream.runCollect,
				Effect.forkChild,
			);
			yield* Deferred.await(ready);
			const rejected = yield* set
				.reload({core: [spell("bad"), spell("bad")], programs: [], keys: []})
				.pipe(Effect.result);
			assert.strictEqual(rejected._tag, "Failure");
			assert.deepStrictEqual(
				(yield* registry.describe).map((row) => row.path),
				[["before"]],
			);
			yield* set.reload({
				core: [spell("after")],
				programs: [],
				keys: [{file: "reload", bindings: {x: "after"}}],
			});
			const descriptions = yield* Fiber.join(observed);
			assert.deepStrictEqual(
				descriptions.map((rows) => rows.map((row) => row.path)),
				[[["before"]], [["after"]]],
			);
			const state = yield* set.read;
			assert.strictEqual(state.bindings.errors.length, 0);
			assert.deepStrictEqual(
				state.table.rows.map((row) => row.path),
				[["after"]],
			);
		}).pipe(Effect.provide(SpellSet.layer({core: [spell("before")], programs: [], keys: []}))),
);
