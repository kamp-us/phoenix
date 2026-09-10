import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {compileBindings, type KeyBindings} from "./compile.ts";
import {renderBindingErrors} from "./errors.ts";
import {describeFile} from "./file.ts";
import {registry} from "./fixtures.ts";

const file = describeFile({
	layer: "global",
	path: "/home/someone/.tuval/tuval.config.ts",
	base: "/home/someone",
});

const lines = (bindings: KeyBindings) =>
	Effect.flatMap(registry(), (table) =>
		Effect.map(compileBindings({file, bindings}, table), (compiled) =>
			renderBindingErrors(compiled.errors),
		),
	);

describe("renderBindingErrors", () => {
	it.effect("renders a mistyped spell with the nearest one it holds", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* lines({"ctrl+x": "windwo close"}), [
				'global .tuval/tuval.config.ts: cannot bind "ctrl+x": at character 0, expected window|workspace; did you mean "window"?',
			]);
		}),
	);

	it.effect("renders a binding that stops before an argument it owes", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* lines({"ctrl+1": "workspace activate"}), [
				'global .tuval/tuval.config.ts: cannot bind "ctrl+1": at character 18, expected <workspace>',
			]);
		}),
	);

	it.effect("renders an argument outside the choices its parameter allows", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* lines({"ctrl+l": "window swap sideways"}), [
				'global .tuval/tuval.config.ts: cannot bind "ctrl+l": at character 12, expected left|right|up|down',
			]);
		}),
	);

	it.effect("renders one line per error, in the order the config wrote them", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(
				yield* lines({"ctrl+x": "windwo close", "ctrl+1": "workspace activate"}),
				[
					'global .tuval/tuval.config.ts: cannot bind "ctrl+x": at character 0, expected window|workspace; did you mean "window"?',
					'global .tuval/tuval.config.ts: cannot bind "ctrl+1": at character 18, expected <workspace>',
				],
			);
		}),
	);

	it.effect("renders nothing when every binding compiled", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* lines({"ctrl+w": "window close"}), []);
		}),
	);
});
