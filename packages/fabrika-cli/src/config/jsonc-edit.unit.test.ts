import {describe, expect, it} from "vitest";
import {stripJsonComments} from "./document.ts";
import {setJsoncValue} from "./jsonc-edit.ts";

const RULES = [{paths: ["**"], mode: "hand-check"}];

const edited = (text: string, path: readonly [string, ...string[]], value: unknown): string => {
	const edit = setJsoncValue(text, path, value);
	if (edit._tag === "Refused") throw new Error(edit.reason);
	return edit.text;
};

const parsed = (text: string): unknown => JSON.parse(stripJsonComments(text));

describe("setJsoncValue", () => {
	it("appends a missing member after the last one and leaves every earlier byte in place", () => {
		const before = [
			"// why this file exists",
			"{",
			'\t"trunk": "main", // the default branch',
			"\t/* validators run in CI too */",
			'\t"codeValidators": [{"command": ["pnpm", "lint"]}] // keep in step with ci.yml',
			"}",
			"",
		].join("\n");
		expect(edited(before, ["reviewUi", "whenNoPreview"], RULES)).toBe(
			[
				"// why this file exists",
				"{",
				'\t"trunk": "main", // the default branch',
				"\t/* validators run in CI too */",
				'\t"codeValidators": [{"command": ["pnpm", "lint"]}], // keep in step with ci.yml',
				'\t"reviewUi": {',
				'\t\t"whenNoPreview": [',
				"\t\t\t{",
				'\t\t\t\t"paths": [',
				'\t\t\t\t\t"**"',
				"\t\t\t\t],",
				'\t\t\t\t"mode": "hand-check"',
				"\t\t\t}",
				"\t\t]",
				"\t}",
				"}",
				"",
			].join("\n"),
		);
	});

	it("appends into a nested object that lacks the last key, keeping its comments", () => {
		const before = '{\n  "reviewUi": {\n    // rules land here\n  },\n  "trunk": "main"\n}\n';
		const after = edited(before, ["reviewUi", "whenNoPreview"], RULES);
		expect(after).toContain('// rules land here\n    "whenNoPreview": [');
		expect(after.endsWith('  },\n  "trunk": "main"\n}\n')).toBe(true);
		expect(parsed(after)).toEqual({reviewUi: {whenNoPreview: RULES}, trunk: "main"});
	});

	it("replaces a value already there and nothing around it", () => {
		const before = '{\n\t"reviewUi": {"whenNoPreview": [] /* none yet */},\n\t"trunk": "main"\n}\n';
		const after = edited(before, ["reviewUi", "whenNoPreview"], RULES);
		expect(after).toContain('/* none yet */},\n\t"trunk": "main"\n}\n');
		expect(parsed(after)).toEqual({reviewUi: {whenNoPreview: RULES}, trunk: "main"});
	});

	it("reads comment markers and braces inside a string as part of the string", () => {
		const before = '{"docs": "https://example.test/a//b", "note": "} // not a comment"}';
		expect(parsed(edited(before, ["reviewUi"], {whenNoPreview: RULES}))).toEqual({
			docs: "https://example.test/a//b",
			note: "} // not a comment",
			reviewUi: {whenNoPreview: RULES},
		});
	});

	it("fills an empty object", () => {
		expect(parsed(edited("{}\n", ["reviewUi", "whenNoPreview"], RULES))).toEqual({
			reviewUi: {whenNoPreview: RULES},
		});
	});

	it("refuses to step through a value that is not an object", () => {
		expect(setJsoncValue('{"reviewUi": []}', ["reviewUi", "whenNoPreview"], RULES)).toEqual({
			_tag: "Refused",
			reason: '"reviewUi" is not an object',
		});
	});

	it("refuses a document that is not an object", () => {
		expect(setJsoncValue("[1, 2]", ["reviewUi"], {})._tag).toBe("Refused");
	});
});
