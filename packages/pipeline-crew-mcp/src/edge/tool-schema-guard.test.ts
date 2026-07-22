/**
 * The boot fence over generated MCP `inputSchema` shapes (#3753): a tool whose schema is not a
 * top-level `{"type":"object"}` is named and fails the build, because a client rejects the entire
 * tools/list response on one bad schema and every other tool goes with it.
 *
 * The invalid fixture is `Schema.Struct({})` — the literal defect this fences: effect-smol renders an
 * object with zero property AND zero index signatures as `{"anyOf":[{"type":"object"},{"type":"array"}]}`
 * (`effect/src/internal/schema/representation.ts`, the `Objects` case), so the fixture stays honest
 * against the real emitter instead of a hand-written schema the emitter would never produce.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Schema} from "effect";
import {Tool, Toolkit} from "effect/unstable/ai";
import {ClaimToolkit} from "./claim-tool.ts";
import {KindsToolkit} from "./kinds-tool.ts";
import {ChannelToolkit} from "./send-tool.ts";
import {assertToolSchemas, findInvalidToolSchemas} from "./tool-schema-guard.ts";

const InvalidToolkit = Toolkit.make(
	Tool.make("spec_invalid_tool", {parameters: Schema.Struct({}), success: Schema.String}),
);

describe("edge/tool-schema-guard — the boot fence on generated inputSchema (#3753)", () => {
	it("passes every tool the crew session registers", () => {
		assert.deepStrictEqual(
			findInvalidToolSchemas([ChannelToolkit, ClaimToolkit, KindsToolkit]),
			[],
		);
	});

	it("channel_kinds generates a top-level object schema", () => {
		assert.deepStrictEqual(Tool.getJsonSchema(KindsToolkit.tools.channel_kinds), {
			type: "object",
			additionalProperties: false,
		});
	});

	it("flags a tool whose generated schema is not a top-level object", () => {
		const invalid = findInvalidToolSchemas([InvalidToolkit]);
		assert.deepStrictEqual(
			invalid.map(({tool}) => tool),
			["spec_invalid_tool"],
		);
		assert.deepStrictEqual(invalid[0]?.inputSchema, {
			anyOf: [{type: "object"}, {type: "array"}],
		});
	});

	it.effect("fails loudly, naming the offending tool", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(assertToolSchemas([KindsToolkit, InvalidToolkit]));
			assert.deepStrictEqual([...error.tools], ["spec_invalid_tool"]);
			assert.include(error.message, "spec_invalid_tool");
			assert.include(error.message, '{"anyOf":[{"type":"object"},{"type":"array"}]}');
		}),
	);
});
