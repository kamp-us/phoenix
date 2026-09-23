import {assert, describe, it} from "@effect/vitest";
import {Schema} from "effect";
import {SpellDescription} from "./registry-description.ts";

const decode = Schema.decodeUnknownSync(SpellDescription);

const row = (params: unknown) => ({
	path: ["window", "split"],
	describe: "Split the focused window.",
	params,
	capabilities: [],
});

describe("SpellDescription.params", () => {
	// The type is only worth what the real renderer emits, so it is pinned against that rather than
	// against a hand-written document that could drift with the pin.
	it("decodes what Schema.toJsonSchemaDocument emits", () => {
		const params = Schema.toJsonSchemaDocument(
			Schema.Struct({
				orientation: Schema.Literals(["row", "column"]),
				ratio: Schema.optionalKey(Schema.String),
			}),
		);
		assert.deepStrictEqual(decode(row(params)).params, params);
	});

	it("decodes a document whose root is a $ref into its definitions", () => {
		class SplitArgs extends Schema.Class<SplitArgs>("SplitArgs")({
			orientation: Schema.String,
		}) {}
		const params = Schema.toJsonSchemaDocument(SplitArgs);
		assert.isString((params.schema as {$ref?: unknown}).$ref);
		assert.deepStrictEqual(decode(row(params)).params, params);
	});

	// The shape this issue exists for: a bare JSON Schema object is what a fixture reaches for and
	// what the kernel never emits, so the wire type has to refuse it rather than let a reader paper
	// over it (#7758).
	it("refuses a bare JSON Schema object", () => {
		assert.throws(() => decode(row({type: "object", properties: {orientation: {type: "string"}}})));
	});

	it("refuses a document tagged with another dialect", () => {
		assert.throws(() => decode(row({dialect: "draft-07", schema: {}, definitions: {}})));
	});

	it("refuses a document missing its definitions", () => {
		assert.throws(() => decode(row({dialect: "draft-2020-12", schema: {}})));
	});
});
