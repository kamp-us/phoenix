import {Result, Schema} from "effect";
import {describe, expect, it} from "vitest";
import {firstSchemaIssue, parameterOf} from "./issue.ts";

const failureOf = (schema: Schema.Codec<unknown>, value: unknown) => {
	const decoded = Schema.decodeUnknownResult(schema)(value);
	if (!Result.isFailure(decoded)) throw new Error("expected the decode to fail");
	return firstSchemaIssue(decoded.failure);
};

describe("parameterOf", () => {
	it("names nothing when the whole value is at fault", () => {
		expect(parameterOf("")).toBe("");
	});

	it("returns a single segment unchanged", () => {
		expect(parameterOf("columns")).toBe("columns");
	});

	it("ends the name at either separator `renderPath` emits", () => {
		expect(parameterOf("target.name")).toBe("target");
		expect(parameterOf("items[0]")).toBe("items");
		expect(parameterOf("rows[2].cells[1].text")).toBe("rows");
	});

	it("names nothing when the path opens on an index", () => {
		expect(parameterOf("[0].name")).toBe("");
	});
});

describe("firstSchemaIssue", () => {
	// `parameterOf` reads what `renderPath` writes, so the two separators are pinned against real
	// decodes rather than against a hand-written path.
	it("renders a nested key path its leading parameter can be read back out of", () => {
		const {at} = failureOf(Schema.Struct({target: Schema.Struct({name: Schema.String})}), {
			target: {name: 3},
		});

		expect(at).toBe("target.name");
		expect(parameterOf(at)).toBe("target");
	});

	it("renders an indexed path its leading parameter can be read back out of", () => {
		const {at} = failureOf(Schema.Struct({items: Schema.Array(Schema.Finite)}), {
			items: [1, "x"],
		});

		expect(at).toBe("items[1]");
		expect(parameterOf(at)).toBe("items");
	});
});
