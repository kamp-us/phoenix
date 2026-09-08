import {Schema} from "effect";
import {expect, it} from "vitest";
import {REST_PARAMETER_ANNOTATION, RestParameter} from "../../commands/rest-parameter.ts";
import {decodeServerFrame} from "./wire.ts";

const description = {
	path: ["help"],
	describe: "Help",
	capabilities: [],
	params: Schema.toJsonSchemaDocument(Schema.Struct({path: Schema.optionalKey(RestParameter)}), {
		includeAnnotationKey: (key) => key === REST_PARAMETER_ANNOTATION,
	}),
};

it("admits live descriptions without losing optional or rest metadata", () => {
	const frame = {kind: "tuval/transport/spell-registry/v1", registry: [description]};
	expect(decodeServerFrame(JSON.stringify(frame))).toEqual({_tag: "Frame", frame});
});

it.each([
	{},
	[{...description, path: []}],
	[{...description, params: {}}],
	[{...description, capabilities: [{}]}],
])("refuses malformed live descriptions: %j", (registry) => {
	expect(
		decodeServerFrame(JSON.stringify({kind: "tuval/transport/spell-registry/v1", registry}))._tag,
	).toBe("Undecodable");
});

it("refuses a description whose explicit rest metadata cannot be parsed", () => {
	const params = {
		...description.params,
		schema: {
			type: "object",
			properties: {path: {type: "boolean", [REST_PARAMETER_ANNOTATION]: true}},
		},
	};
	expect(
		decodeServerFrame(
			JSON.stringify({
				kind: "tuval/transport/spell-registry/v1",
				registry: [{...description, params}],
			}),
		)._tag,
	).toBe("Undecodable");
});
