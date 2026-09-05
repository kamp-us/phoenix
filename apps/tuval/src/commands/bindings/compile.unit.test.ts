import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {type AnySpell, renderPath} from "../spell.ts";
import {type BindingSource, compileBindings, type KeyBindings} from "./compile.ts";
import {renderBindingErrors} from "./errors.ts";
import {registry, spells} from "./fixtures.ts";

const FILE = "global .tuval/tuval.config.ts";

const compile = (bindings: KeyBindings, only?: ReadonlyArray<AnySpell>) =>
	Effect.flatMap(registry(only), (table) =>
		compileBindings({file: FILE, bindings} satisfies BindingSource, table),
	);

const withoutSwap = spells.filter((spell) => renderPath(spell.path) !== "window.swap");

describe("compileBindings", () => {
	it.effect("compiles the valid bindings and reports the one naming an unknown spell", () =>
		Effect.gen(function* () {
			const {bindings, errors} = yield* compile({
				"ctrl+w": "window close",
				"ctrl+n": "workspace next",
				"ctrl+l": "window swap right",
				"ctrl+x": "windwo close",
			});

			assert.deepStrictEqual(
				bindings.map((binding) => binding.key),
				["ctrl+w", "ctrl+n", "ctrl+l"],
			);
			assert.lengthOf(errors, 1);
			const [error] = errors;
			assert.strictEqual(error?.file, FILE);
			assert.strictEqual(error?.key, "ctrl+x");
			assert.strictEqual(error?.position, 0);
			assert.strictEqual(error?.expected, "window|workspace");
			assert.strictEqual(error?.didYouMean, "window");
		}),
	);

	it.effect("carries the arguments the spell's params decoded, not the token text", () =>
		Effect.gen(function* () {
			const {bindings, errors} = yield* compile({"ctrl+.": "window grow 3"});

			assert.deepStrictEqual(errors, []);
			assert.deepStrictEqual(bindings, [
				{key: "ctrl+.", path: ["window", "grow"], args: {columns: 3}},
			]);
		}),
	);

	it.effect(
		"reports an argument the spell's params refuse, pointing at the argument's own token",
		() =>
			Effect.gen(function* () {
				const {bindings, errors} = yield* compile({"ctrl+.": "window grow wide"});

				assert.deepStrictEqual(bindings, []);
				assert.lengthOf(errors, 1);
				const [error] = errors;
				assert.strictEqual(error?.file, FILE);
				assert.strictEqual(error?.key, "ctrl+.");
				assert.strictEqual(error?.position, 12);
				assert.include(error?.message ?? "", "at character 12");
			}),
	);

	it.effect("sets `repeat` from the object form and leaves it unset for a bare string", () =>
		Effect.gen(function* () {
			const {bindings, errors} = yield* compile({
				"ctrl+n": {command: "workspace next", repeat: true},
				"ctrl+w": "window close",
			});

			assert.deepStrictEqual(errors, []);
			assert.deepStrictEqual(bindings, [
				{key: "ctrl+n", path: ["workspace", "next"], args: {}, repeat: true},
				{key: "ctrl+w", path: ["window", "close"], args: {}},
			]);
		}),
	);

	it.effect("reports a binding that never finished naming its arguments", () =>
		Effect.gen(function* () {
			const {bindings, errors} = yield* compile({"ctrl+1": "workspace activate"});

			assert.deepStrictEqual(bindings, []);
			const [error] = errors;
			assert.strictEqual(error?.key, "ctrl+1");
			assert.strictEqual(error?.position, "workspace activate".length);
			assert.strictEqual(error?.expected, "<workspace>");
		}),
	);

	it.effect("re-validates every binding against the registry it is handed", () =>
		Effect.gen(function* () {
			const bindings: KeyBindings = {
				"ctrl+w": "window close",
				"ctrl+l": "window swap right",
				"ctrl+n": "workspace next",
			};

			const before = yield* compile(bindings);
			assert.deepStrictEqual(before.errors, []);
			assert.lengthOf(before.bindings, 3);

			const after = yield* compile(bindings, withoutSwap);
			assert.deepStrictEqual(
				after.bindings.map((binding) => binding.key),
				["ctrl+w", "ctrl+n"],
			);
			assert.deepStrictEqual(
				after.errors.map((error) => error.key),
				["ctrl+l"],
			);
		}),
	);

	it.effect("names no absolute path in any line it renders", () =>
		Effect.gen(function* () {
			const {errors} = yield* compile({
				"ctrl+x": "windwo close",
				"ctrl+1": "workspace activate",
			});
			const lines = renderBindingErrors(errors);

			assert.lengthOf(lines, 2);
			for (const line of lines) {
				assert.strictEqual(line.startsWith(FILE), true);
				assert.notMatch(line, /(^|\s)[/~]/);
			}
		}),
	);
});
