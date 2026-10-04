import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {APPETITE_SIZES, appetiteSizesKey, describeSizes} from "./appetite-sizes.ts";

const declared = (value: unknown) =>
	resolve(
		loadConfig({_tag: "Text", text: JSON.stringify({[APPETITE_SIZES]: value})}),
		appetiteSizesKey,
	);

describe("a repo that declares nothing gets the ruled sizes", () => {
	it("resolves S = 15, M = 35, L = 40 with no config at all", () => {
		const resolved = resolve(loadConfig({_tag: "Absent"}), appetiteSizesKey);
		expect(resolved).toMatchObject({_tag: "Default", value: {S: 15, M: 35, L: 40}});
	});
});

describe("a declared table names all three sizes, rising from S to L", () => {
	it("takes the amounts the repo wrote, fractions included", () => {
		expect(declared({S: 10, M: 22.5, L: 60})).toEqual({
			_tag: "Declared",
			layer: "tracked",
			value: {S: 10, M: 22.5, L: 60},
		});
	});

	it.each([
		["a missing size", {S: 10, M: 20}],
		["an extra key", {S: 10, M: 20, L: 30, XL: 40}],
		["a zero amount", {S: 0, M: 20, L: 30}],
		["a string amount", {S: "10", M: 20, L: 30}],
		["two equal sizes", {S: 10, M: 10, L: 30}],
		["a falling order", {S: 30, M: 20, L: 10}],
		["a list", [10, 20, 30]],
		["null", null],
	])("refuses %s, naming the key", (_why, value) => {
		const resolved = declared(value);
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain(APPETITE_SIZES);
	});
});

describe("describeSizes", () => {
	it("names every size with its dollar amount, smallest first", () => {
		expect(describeSizes({S: 15, M: 35, L: 40})).toBe("S = $15, M = $35, L = $40");
	});
});

describe("the JSON schema fragment", () => {
	it("documents the three sizes as required positive numbers and nothing else", () => {
		expect(appetiteSizesKey.jsonSchema).toMatchObject({
			type: "object",
			required: ["S", "M", "L"],
			additionalProperties: false,
			properties: {
				S: {type: "number", exclusiveMinimum: 0},
				M: {type: "number", exclusiveMinimum: 0},
				L: {type: "number", exclusiveMinimum: 0},
			},
		});
	});
});
