import {assert, describe, expect, it} from "@effect/vitest";
import {Effect} from "effect";
import {SpellRegistry} from "../registry.ts";
import {scope, smallerTable, table} from "./fixtures.ts";
import {helpSpell, renderHelp} from "./help.ts";

const ask = (path?: string) =>
	Effect.flatMap(table, (built) =>
		helpSpell
			.execute(path === undefined ? {} : {path}, scope)
			.pipe(Effect.provide(SpellRegistry.layer(built))),
	);

describe("help", () => {
	it.effect("lists every registered spell once, grouped by first segment and sorted", () =>
		Effect.gen(function* () {
			const rows = yield* ask();
			assert.deepStrictEqual(
				rows.map((row) => row.path),
				[
					"editor buffer next",
					"editor save",
					"help",
					"spell describe",
					"spell list",
					"window close",
					"window focus",
					"window swap",
				],
			);
		}),
	);

	it.effect("derives the usage column from each spell's own params", () =>
		Effect.gen(function* () {
			const rows = yield* ask("window");
			assert.deepStrictEqual(rows, [
				{path: "window close", usage: "", describe: "Close the focused window"},
				{
					path: "window focus",
					usage: "left|right|up|down [<count>]",
					describe: "Focus the neighbour in one direction",
				},
				{
					path: "window swap",
					usage: "<dir>",
					describe: "Swap with the neighbour: left|right|up|down",
				},
			]);
		}),
	);

	it.effect("renders the subtree as the aligned table the palette shows", () =>
		Effect.gen(function* () {
			assert.strictEqual(
				renderHelp(yield* ask("window")),
				[
					"window close                                Close the focused window",
					"window focus left|right|up|down [<count>]   Focus the neighbour in one direction",
					"window swap <dir>                           Swap with the neighbour: left|right|up|down",
				].join("\n"),
			);
		}),
	);

	it.effect("reads a path written with either separator", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(
				(yield* ask("window.close")).map((row) => row.path),
				["window close"],
			);
			assert.deepStrictEqual(
				(yield* ask("spell describe")).map((row) => row.path),
				["spell describe"],
			);
		}),
	);

	it.effect("refuses a path no spell answers to, naming the nearest group", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flatMap(table, (built) =>
				helpSpell
					.execute({path: "windwo"}, scope)
					.pipe(Effect.provide(SpellRegistry.layer(built)), Effect.flip),
			);
			assert.strictEqual(error.path, "windwo");
			assert.strictEqual(error.didYouMean, "window");
		}),
	);

	it.effect("reflects a swapped table with no restart", () =>
		Effect.gen(function* () {
			const built = yield* table;
			const next = yield* smallerTable;
			const paths = yield* Effect.gen(function* () {
				const before = yield* helpSpell.execute({}, scope);
				const registry = yield* SpellRegistry;
				yield* registry.swap(next);
				const after = yield* helpSpell.execute({}, scope);
				return {
					before: before.map((row) => row.path),
					after: after.map((row) => row.path),
				};
			}).pipe(Effect.provide(SpellRegistry.layer(built)));
			assert.include(paths.before, "window close");
			assert.deepStrictEqual(paths.after, ["help", "spell describe", "spell list"]);
		}),
	);
});

describe("renderHelp", () => {
	it("renders nothing for no rows", () => {
		expect(renderHelp([])).toBe("");
	});
});
