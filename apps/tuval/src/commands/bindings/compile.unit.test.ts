import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type AnySpell, renderPath} from "../spell.ts";
import {type BindingSource, compileBindings, type KeyBindings} from "./compile.ts";
import {renderBindingErrors} from "./errors.ts";
import {registry, spells} from "./fixtures.ts";

const FILE = "global .tuval/tuval.config.ts";

const compile = (bindings: KeyBindings, only?: ReadonlyArray<AnySpell>) =>
	Effect.runPromise(
		Effect.flatMap(registry(only), (table) =>
			compileBindings({file: FILE, bindings} satisfies BindingSource, table),
		),
	);

const withoutSwap = spells.filter((spell) => renderPath(spell.path) !== "window.swap");

describe("compileBindings", () => {
	it("compiles the valid bindings and reports the one naming an unknown spell", async () => {
		const {bindings, errors} = await compile({
			"ctrl+w": "window close",
			"ctrl+n": "workspace next",
			"ctrl+l": "window swap right",
			"ctrl+x": "windwo close",
		});

		expect(bindings.map((binding) => binding.key)).toEqual(["ctrl+w", "ctrl+n", "ctrl+l"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			file: FILE,
			key: "ctrl+x",
			position: 0,
			expected: "window|workspace",
			didYouMean: "window",
		});
	});

	it("carries the arguments the spell's params decoded, not the token text", async () => {
		const {bindings, errors} = await compile({"ctrl+.": "window grow 3"});

		expect(errors).toEqual([]);
		expect(bindings).toEqual([{key: "ctrl+.", path: ["window", "grow"], args: {columns: 3}}]);
	});

	it("reports an argument the spell's params refuse, pointing at the argument's own token", async () => {
		const {bindings, errors} = await compile({"ctrl+.": "window grow wide"});

		expect(bindings).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({file: FILE, key: "ctrl+.", position: 12});
		expect(errors[0]?.message).toContain("at character 12");
	});

	it("points at the nested parameter's own token, not at the first argument", async () => {
		const command = "window place main 3,wide";
		const {bindings, errors} = await compile({"ctrl+p": command});

		expect(bindings).toEqual([]);
		// `at` is `at.row` here and `args` is keyed by the bare `at`: without resolving the path to
		// its parameter the lookup misses and the caret falls back to `main`, which is fine.
		expect(errors[0]).toMatchObject({key: "ctrl+p", position: command.indexOf("3,wide")});
	});

	it("points at the token behind an indexed path segment", async () => {
		const command = "window fit main 3,wide";
		const {errors} = await compile({"ctrl+f": command});

		// `sizes[1]` opens on the same parameter name, so `[` ends it exactly as `.` does.
		expect(errors[0]).toMatchObject({key: "ctrl+f", position: command.indexOf("3,wide")});
	});

	it("sets `repeat` from the object form and leaves it unset for a bare string", async () => {
		const {bindings, errors} = await compile({
			"ctrl+n": {command: "workspace next", repeat: true},
			"ctrl+w": "window close",
		});

		expect(errors).toEqual([]);
		expect(bindings).toEqual([
			{key: "ctrl+n", path: ["workspace", "next"], args: {}, repeat: true},
			{key: "ctrl+w", path: ["window", "close"], args: {}},
		]);
	});

	it("reports a binding that never finished naming its arguments", async () => {
		const {bindings, errors} = await compile({"ctrl+1": "workspace activate"});

		expect(bindings).toEqual([]);
		expect(errors[0]).toMatchObject({
			key: "ctrl+1",
			position: "workspace activate".length,
			expected: "<workspace>",
		});
	});

	it("re-validates every binding against the registry it is handed", async () => {
		const bindings: KeyBindings = {
			"ctrl+w": "window close",
			"ctrl+l": "window swap right",
			"ctrl+n": "workspace next",
		};

		const before = await compile(bindings);
		expect(before.errors).toEqual([]);
		expect(before.bindings).toHaveLength(3);

		const after = await compile(bindings, withoutSwap);
		expect(after.bindings.map((binding) => binding.key)).toEqual(["ctrl+w", "ctrl+n"]);
		expect(after.errors.map((error) => error.key)).toEqual(["ctrl+l"]);
	});

	it("names no absolute path in any line it renders", async () => {
		const {errors} = await compile({"ctrl+x": "windwo close", "ctrl+1": "workspace activate"});
		const lines = renderBindingErrors(errors);

		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(line.startsWith(FILE)).toBe(true);
			expect(line).not.toMatch(/(^|\s)[/~]/);
		}
	});
});
