import {describe, expect, it} from "vitest";
import {
	assembleSchema,
	CONFIG_SCHEMA_FILE,
	META_SCHEMA,
	schemaMatches,
	serializeSchema,
} from "./json-schema.ts";
import {type KeyGroup, register} from "./key-group.ts";
import {KEY_GROUPS} from "./registry.ts";

const noop: KeyGroup<string> = {
	key: "example",
	shippedDefault: "",
	decode: () => ({_tag: "Value", value: ""}),
};

describe("the assembly is complete only when every registered key carries a fragment", () => {
	it("assembles a document over the real registry — every key has a fragment", () => {
		const assembly = assembleSchema(KEY_GROUPS);
		expect(assembly._tag).toBe("Complete");
		if (assembly._tag !== "Complete") return;
		expect(assembly.schema.$schema).toBe(META_SCHEMA);
		expect(assembly.schema.additionalProperties).toBe(false);
		// $schema self-pointer plus one property per registered key.
		expect(Object.keys(assembly.schema.properties)).toHaveLength(KEY_GROUPS.length + 1);
		expect(assembly.schema.properties.$schema?.type).toBe("string");
	});

	it("refuses the assembly and names a key that carries no fragment", () => {
		const assembly = assembleSchema([...KEY_GROUPS, register(noop)]);
		expect(assembly._tag).toBe("Incomplete");
		if (assembly._tag !== "Incomplete") return;
		expect(assembly.missing).toEqual(["example"]);
	});

	it("keeps the registry's order, $schema first", () => {
		const assembly = assembleSchema(KEY_GROUPS);
		if (assembly._tag !== "Complete") throw new Error("expected complete");
		const keys = Object.keys(assembly.schema.properties);
		expect(keys[0]).toBe("$schema");
		expect(keys.slice(1)).toEqual(KEY_GROUPS.map((one) => one.key));
	});
});

describe("serialize and match round-trip", () => {
	it("serializes to tab-indented JSON with one trailing newline", () => {
		const assembly = assembleSchema(KEY_GROUPS);
		if (assembly._tag !== "Complete") throw new Error("expected complete");
		const text = serializeSchema(assembly.schema);
		expect(text.endsWith("}\n")).toBe(true);
		expect(text).toContain('\n\t"$schema"');
		expect(schemaMatches(JSON.parse(text), assembly.schema)).toBe(true);
	});

	it("does not match a document with a changed value, whatever its whitespace", () => {
		const assembly = assembleSchema(KEY_GROUPS);
		if (assembly._tag !== "Complete") throw new Error("expected complete");
		const drifted = {...assembly.schema, title: "changed"};
		expect(schemaMatches(drifted, assembly.schema)).toBe(false);
		// Re-formatting the identical content is still a match.
		const reformatted = JSON.parse(JSON.stringify(assembly.schema, null, 4));
		expect(schemaMatches(reformatted, assembly.schema)).toBe(true);
	});
});

describe("the schema file name is the committed pointer target", () => {
	it("is .fabrika.schema.json", () => {
		expect(CONFIG_SCHEMA_FILE).toBe(".fabrika.schema.json");
	});
});
