import {describe, expect, it} from "vitest";
import {FRESH_JSON_LAYOUT, readJsonLayout, renderJson} from "./json-layout.ts";

const VALUE = {name: "site", scripts: {build: "tsc"}};

describe("a JSON file's layout survives a re-render", () => {
	it.each([
		["two spaces", "  "],
		["four spaces", "    "],
		["tabs", "\t"],
	])("keeps %s", (_label, indent) => {
		const text = `${JSON.stringify(VALUE, null, indent)}\n`;
		expect(readJsonLayout(text).indent).toBe(indent);
		expect(renderJson(JSON.parse(text), readJsonLayout(text))).toBe(text);
	});

	it("keeps a file that ends without a newline ending without one", () => {
		const text = JSON.stringify(VALUE, null, 2);
		expect(renderJson(VALUE, readJsonLayout(text))).toBe(text);
	});

	it("keeps CRLF line endings", () => {
		const text = `${JSON.stringify(VALUE, null, 2).replace(/\n/g, "\r\n")}\r\n`;
		expect(renderJson(VALUE, readJsonLayout(text))).toBe(text);
	});

	it("gives a file with no indented line the fresh layout's indent", () => {
		expect(readJsonLayout("{}\n")).toEqual(FRESH_JSON_LAYOUT);
		expect(readJsonLayout('{"a":1}')).toEqual({...FRESH_JSON_LAYOUT, finalNewline: false});
	});

	it("writes a file from nothing tab-indented with a final newline", () => {
		expect(renderJson({a: {b: 1}}, FRESH_JSON_LAYOUT)).toBe('{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n');
	});
});
