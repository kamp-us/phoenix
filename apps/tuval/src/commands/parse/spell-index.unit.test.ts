import {Schema} from "effect";
import {describe, expect, it} from "vitest";
import {emptyParams} from "../../protocol/fixtures.ts";
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

	it("follows a root $ref into the document's definitions", () => {
		// A `Schema.Class` params renders as a bare `$ref` with the object under `definitions`, so
		// reading only the root would report a spell with parameters as having none, and every
		// argument to it would then refuse with "no further arguments".
		class RenameArgs extends Schema.Class<RenameArgs>("RenameArgs")({
			workspace: Schema.String,
			name: Schema.optionalKey(Schema.String),
		}) {}
		const params = Schema.toJsonSchemaDocument(RenameArgs);
		expect((params.schema as {$ref?: string}).$ref).toBeDefined();
		expect(readParams(params)).toEqual([
			{name: "workspace", required: true},
			{name: "name", required: false},
		]);
	});

	it("follows a root $ref on an identifier-annotated struct, literals included", () => {
		const params = Schema.toJsonSchemaDocument(
			Schema.Struct({direction: Schema.Literals(["left", "right"])}).annotate({
				identifier: "MoveArgs",
			}),
		);
		expect(readParams(params)).toEqual([
			{name: "direction", required: true, literals: ["left", "right"]},
		]);
	});

	it("reads a parameterless spell as no parameters, whatever the wire carried", () => {
		expect(readParams(Schema.toJsonSchemaDocument(Schema.Struct({})))).toEqual([]);
		expect(readParams(undefined)).toEqual([]);
		expect(readParams("not a schema")).toEqual([]);
		expect(readParams({schema: {type: "object"}})).toEqual([]);
		// The bare JSON Schema object the wire type refuses (#7758): the reader no longer reads it
		// as a root, so the drift it used to hide cannot come back through here.
		expect(readParams({type: "object", properties: {name: {type: "string"}}})).toEqual([]);
		// A ref into definitions that hold nothing of that name stays total.
		expect(readParams({schema: {$ref: "#/$defs/Missing"}, definitions: {}})).toEqual([]);
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
		expect([...(window?.children.keys() ?? [])]).toEqual(["close", "move", "focus"]);
		expect(window?.spell).toBeUndefined();
		expect(window?.children.get("close")?.spell?.path).toEqual(["window", "close"]);
	});

	it("drops a row whose path decode would have refused, staying total", () => {
		const index = buildSpellIndex([
			{path: [], describe: "unreachable", params: emptyParams, capabilities: []},
			{path: ["ok"], describe: "reachable", params: emptyParams, capabilities: []},
		]);
		expect(index.spells.map((spell) => spell.path)).toEqual([["ok"]]);
	});
});
