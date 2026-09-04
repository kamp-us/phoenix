import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {SpellRegistry} from "../registry.ts";
import {scope, table} from "./fixtures.ts";
import {spellDescribe, spellList} from "./spell.ts";

const run = <A, E>(body: Effect.Effect<A, E, SpellRegistry>) =>
	Effect.runPromise(
		Effect.flatMap(table, (built) => body.pipe(Effect.provide(SpellRegistry.layer(built)))),
	);

describe("spell list", () => {
	it("returns exactly what the registry describes", async () => {
		const {listed, described} = await run(
			Effect.gen(function* () {
				const registry = yield* SpellRegistry;
				return {
					listed: yield* spellList.execute({}, scope),
					described: yield* registry.describe,
				};
			}),
		);
		expect(listed).toEqual(described);
	});
});

describe("spell describe", () => {
	it("returns one spell's description including its params schema", async () => {
		const found = await run(spellDescribe.execute({path: "window close"}, scope));
		expect(found.path).toEqual(["window", "close"]);
		expect(found.describe).toBe("Close the focused window");
		expect(found.capabilities).toEqual([]);
		expect(found.params).toEqual(
			await run(
				Effect.map(
					Effect.flatMap(SpellRegistry, (registry) => registry.describe),
					(rows) => rows.find((row) => row.path.join(" ") === "window close")?.params,
				),
			),
		);
	});

	it("carries the parameter names a caller has to supply", async () => {
		const found = await run(spellDescribe.execute({path: "window focus"}, scope));
		expect(found.params).toMatchObject({
			schema: {properties: {direction: {enum: ["left", "right", "up", "down"]}}},
		});
	});

	it("refuses an unregistered path with the nearest one", async () => {
		const error = await run(Effect.flip(spellDescribe.execute({path: "windwo close"}, scope)));
		expect(error.path).toBe("windwo close");
		expect(error.didYouMean).toBe("window close");
	});

	it("offers nothing when no registered path is near", async () => {
		const error = await run(Effect.flip(spellDescribe.execute({path: "teapot"}, scope)));
		expect(error.didYouMean).toBeUndefined();
	});
});
