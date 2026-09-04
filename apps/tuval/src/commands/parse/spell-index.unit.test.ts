import {Schema} from "effect";
import {describe, expect, it} from "vitest";
import {registry} from "./fixtures.ts";
import {buildSpellIndex, describeExpected, readParams} from "./spell-index.ts";

describe("readParams", () => {
	// The whole index rests on two properties of the JSON Schema a `SpellDescription` carries, so
	// they are read off the real renderer rather than assumed.
	it("reads the parameters a real Schema.Struct renders to", () => {
		const params = Schema.toJsonSchemaDocument(
			Schema.Struct({
				direction: Schema.Literals(["left", "right", "up", "down"]),
				count: Schema.optionalKey(Schema.String),
			}),
		);
		expect(readParams(params)).toEqual([
			{name: "direction", required: true, literals: ["left", "right", "up", "down"]},
			{name: "count", required: false},
		]);
	});

	it("keeps the struct's declaration order, which is the positional order", () => {
		const params = Schema.toJsonSchemaDocument(
			Schema.Struct({first: Schema.String, second: Schema.String, third: Schema.String}),
		);
		expect(readParams(params).map((param) => param.name)).toEqual(["first", "second", "third"]);
	});

	it("reads a parameterless spell as no parameters, whatever the wire carried", () => {
		expect(readParams(Schema.toJsonSchemaDocument(Schema.Struct({})))).toEqual([]);
		expect(readParams(undefined)).toEqual([]);
		expect(readParams("not a schema")).toEqual([]);
		expect(readParams({schema: {type: "object"}})).toEqual([]);
	});
});

describe("describeExpected", () => {
	it("names a free parameter and enumerates a literal one", () => {
		expect(describeExpected({name: "processId", required: true})).toBe("<processId>");
		expect(
			describeExpected({
				name: "direction",
				required: true,
				literals: ["left", "right", "up", "down"],
			}),
		).toBe("left|right|up|down");
	});
});

describe("buildSpellIndex", () => {
	it("builds the trie the walk descends", () => {
		const window = registry.root.children.get("window");
		expect([...(window?.children.keys() ?? [])]).toEqual(["close", "move"]);
		expect(window?.spell).toBeUndefined();
		expect(window?.children.get("close")?.spell?.path).toEqual(["window", "close"]);
	});

	it("drops a row whose path decode would have refused, staying total", () => {
		const index = buildSpellIndex([
			{path: [], describe: "unreachable", params: undefined, capabilities: []},
			{path: ["ok"], describe: "reachable", params: undefined, capabilities: []},
		]);
		expect(index.spells.map((spell) => spell.path)).toEqual([["ok"]]);
	});
});
