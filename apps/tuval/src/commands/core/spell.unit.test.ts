import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {SpellRegistry} from "../registry.ts";
import {scope, table} from "./fixtures.ts";
import {spellDescribe, spellList} from "./spell.ts";

const run = <A, E>(body: Effect.Effect<A, E, SpellRegistry>) =>
	Effect.flatMap(table, (built) => body.pipe(Effect.provide(SpellRegistry.layer(built))));

describe("spell list", () => {
	it.effect("returns exactly what the registry describes", () =>
		Effect.gen(function* () {
			const {listed, described} = yield* run(
				Effect.gen(function* () {
					const registry = yield* SpellRegistry;
					return {
						listed: yield* spellList.execute({}, scope),
						described: yield* registry.describe,
					};
				}),
			);
			assert.deepStrictEqual(listed, described);
		}),
	);
});

describe("spell describe", () => {
	it.effect("returns one spell's description including its params schema", () =>
		Effect.gen(function* () {
			const found = yield* run(spellDescribe.execute({path: "window close"}, scope));
			assert.deepStrictEqual(found.path, ["window", "close"]);
			assert.strictEqual(found.describe, "Close the focused window");
			assert.deepStrictEqual(found.capabilities, []);
			assert.deepStrictEqual(
				found.params,
				yield* run(
					Effect.map(
						Effect.flatMap(SpellRegistry, (registry) => registry.describe),
						(rows) => rows.find((row) => row.path.join(" ") === "window close")?.params,
					),
				),
			);
		}),
	);

	it.effect("carries the parameter names a caller has to supply", () =>
		Effect.gen(function* () {
			const found = yield* run(spellDescribe.execute({path: "window focus"}, scope));
			const schema = found.params.schema as {
				readonly properties?: {readonly direction?: {readonly enum?: unknown}};
			};
			assert.deepStrictEqual(schema.properties?.direction?.enum, ["left", "right", "up", "down"]);
		}),
	);

	it.effect("refuses an unregistered path with the nearest one", () =>
		Effect.gen(function* () {
			const error = yield* run(Effect.flip(spellDescribe.execute({path: "windwo close"}, scope)));
			assert.strictEqual(error.path, "windwo close");
			assert.strictEqual(error.didYouMean, "window close");
		}),
	);

	it.effect("offers nothing when no registered path is near", () =>
		Effect.gen(function* () {
			const error = yield* run(Effect.flip(spellDescribe.execute({path: "teapot"}, scope)));
			assert.strictEqual(error.didYouMean, undefined);
		}),
	);
});
