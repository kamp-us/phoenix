import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {SpellRegistry} from "../registry.ts";
import {scope, smallerTable, table} from "./fixtures.ts";
import {helpSpell, renderHelp} from "./help.ts";

const ask = (path?: string) =>
	Effect.runPromise(
		Effect.flatMap(table, (built) =>
			helpSpell
				.execute(path === undefined ? {} : {path}, scope)
				.pipe(Effect.provide(SpellRegistry.layer(built))),
		),
	);

describe("help", () => {
	it("lists every registered spell once, grouped by first segment and sorted", async () => {
		const rows = await ask();
		expect(rows.map((row) => row.path)).toEqual([
			"editor buffer next",
			"editor save",
			"help",
			"spell describe",
			"spell list",
			"window close",
			"window focus",
			"window swap",
		]);
	});

	it("derives the usage column from each spell's own params", async () => {
		const rows = await ask("window");
		expect(rows).toEqual([
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
	});

	it("renders the subtree as the aligned table the palette shows", async () => {
		expect(renderHelp(await ask("window"))).toMatchInlineSnapshot(`
			"window close                                Close the focused window
			window focus left|right|up|down [<count>]   Focus the neighbour in one direction
			window swap <dir>                           Swap with the neighbour: left|right|up|down"
		`);
	});

	it("reads a path written with either separator", async () => {
		expect((await ask("window.close")).map((row) => row.path)).toEqual(["window close"]);
		expect((await ask("spell describe")).map((row) => row.path)).toEqual(["spell describe"]);
	});

	it("refuses a path no spell answers to, naming the nearest group", async () => {
		const error = await Effect.runPromise(
			Effect.flatMap(table, (built) =>
				helpSpell
					.execute({path: "windwo"}, scope)
					.pipe(Effect.provide(SpellRegistry.layer(built)), Effect.flip),
			),
		);
		expect(error.path).toBe("windwo");
		expect(error.didYouMean).toBe("window");
	});

	it("reflects a swapped table with no restart", async () => {
		const paths = await Effect.runPromise(
			Effect.gen(function* () {
				const built = yield* table;
				const next = yield* smallerTable;
				return yield* Effect.gen(function* () {
					const before = yield* helpSpell.execute({}, scope);
					const registry = yield* SpellRegistry;
					yield* registry.swap(next);
					const after = yield* helpSpell.execute({}, scope);
					return {
						before: before.map((row) => row.path),
						after: after.map((row) => row.path),
					};
				}).pipe(Effect.provide(SpellRegistry.layer(built)));
			}),
		);
		expect(paths.before).toContain("window close");
		expect(paths.after).toEqual(["help", "spell describe", "spell list"]);
	});
});

describe("renderHelp", () => {
	it("renders nothing for no rows", () => {
		expect(renderHelp([])).toBe("");
	});
});
