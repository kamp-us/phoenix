import {Effect} from "effect";
import {describe, expect, it} from "vitest";
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
	Effect.runPromise(
		Effect.flatMap(registry(), (table) =>
			Effect.map(compileBindings({file, bindings}, table), (compiled) =>
				renderBindingErrors(compiled.errors),
			),
		),
	);

describe("renderBindingErrors", () => {
	it("renders a mistyped spell with the nearest one it holds", async () => {
		expect(await lines({"ctrl+x": "windwo close"})).toMatchInlineSnapshot(`
			[
			  "global .tuval/tuval.config.ts: cannot bind "ctrl+x": at character 0, expected window|workspace; did you mean "window"?",
			]
		`);
	});

	it("renders a binding that stops before an argument it owes", async () => {
		expect(await lines({"ctrl+1": "workspace activate"})).toMatchInlineSnapshot(`
			[
			  "global .tuval/tuval.config.ts: cannot bind "ctrl+1": at character 18, expected <workspace>",
			]
		`);
	});

	it("renders an argument outside the choices its parameter allows", async () => {
		expect(await lines({"ctrl+l": "window swap sideways"})).toMatchInlineSnapshot(`
			[
			  "global .tuval/tuval.config.ts: cannot bind "ctrl+l": at character 12, expected left|right|up|down",
			]
		`);
	});

	it("renders one line per error, in the order the config wrote them", async () => {
		expect(
			await lines({"ctrl+x": "windwo close", "ctrl+1": "workspace activate"}),
		).toMatchInlineSnapshot(`
			[
			  "global .tuval/tuval.config.ts: cannot bind "ctrl+x": at character 0, expected window|workspace; did you mean "window"?",
			  "global .tuval/tuval.config.ts: cannot bind "ctrl+1": at character 18, expected <workspace>",
			]
		`);
	});

	it("renders nothing when every binding compiled", async () => {
		expect(await lines({"ctrl+w": "window close"})).toEqual([]);
	});
});
