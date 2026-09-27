import {describe, expect, it} from "vitest";
import {readDocLeakExempt, readWorkflowValidators, stripJsonComments} from "./repo-config.ts";

describe("readDocLeakExempt", () => {
	it("reads the declared paths, trimmed, in declaration order", () => {
		expect(readDocLeakExempt('{"docLeakExempt": [" /CLAUDE.md ", "/agents/triager.md"]}')).toEqual({
			_tag: "Paths",
			paths: ["/CLAUDE.md", "/agents/triager.md"],
		});
	});

	/** Every one of these is "nothing is exempt" — the strictest answer, never a silent skip. */
	it.each([
		{shape: "no file content at all", text: ""},
		{shape: "a document that is not an object", text: "[]"},
		{shape: "no key", text: '{"other": 1}'},
		{shape: "a key that is not an array", text: '{"docLeakExempt": "/CLAUDE.md"}'},
		{shape: "an empty array", text: '{"docLeakExempt": []}'},
		{shape: "a non-string entry", text: '{"docLeakExempt": [1]}'},
		{shape: "a blank entry", text: '{"docLeakExempt": ["  "]}'},
	])("refuses the whole list on $shape", ({text}) => {
		expect(readDocLeakExempt(text)._tag).toBe("Unusable");
	});
});

describe("stripJsonComments", () => {
	it("drops line and block comments", () => {
		expect(stripJsonComments('{\n\t// who may clear\n\t"a": 1 /* and why */\n}')).toBe(
			'{\n\t\n\t"a": 1 \n}',
		);
	});

	it("leaves a comment sequence inside a string alone — a URL is not a comment", () => {
		expect(stripJsonComments('{"a": "https://kamp.us/x"}')).toBe('{"a": "https://kamp.us/x"}');
		expect(stripJsonComments('{"a": "an escaped \\" then // not a comment"}')).toBe(
			'{"a": "an escaped \\" then // not a comment"}',
		);
	});
});

describe("readWorkflowValidators", () => {
	it("reads each declared command with the files it opens, in declaration order", () => {
		expect(
			readWorkflowValidators(
				'{"workflowValidators": [{"command": ["node", "guards/bin.js", "check"], "reads": [".github/workflows/ci.yml"]}, {"command": ["lint-workflows"], "reads": [".github/workflows/a.yml", ".github/workflows/b.yml"]}]}',
			),
		).toEqual({
			_tag: "Validators",
			validators: [
				{argv: ["node", "guards/bin.js", "check"], reads: [".github/workflows/ci.yml"]},
				{
					argv: ["lint-workflows"],
					reads: [".github/workflows/a.yml", ".github/workflows/b.yml"],
				},
			],
		});
	});

	/** Every one of these is "this repo declares none" — the surface then stands on actionlint alone. */
	it.each([
		{shape: "no file content at all", text: ""},
		{shape: "a document that is not an object", text: "[]"},
		{shape: "no key", text: '{"other": 1}'},
		{shape: "a key that is not an array", text: '{"workflowValidators": "actionlint"}'},
		{shape: "an empty array", text: '{"workflowValidators": []}'},
		{shape: "an entry that is a bare string", text: '{"workflowValidators": ["actionlint"]}'},
		{
			shape: "a bare argv, which declares no file it opens",
			text: '{"workflowValidators": [["actionlint"]]}',
		},
		{shape: "an empty argv", text: '{"workflowValidators": [{"command": [], "reads": ["a.yml"]}]}'},
		{
			shape: "an argv holding a non-string",
			text: '{"workflowValidators": [{"command": ["node", 7], "reads": ["a.yml"]}]}',
		},
		{shape: "no reads key", text: '{"workflowValidators": [{"command": ["actionlint"]}]}'},
		{
			shape: "an empty reads list",
			text: '{"workflowValidators": [{"command": ["actionlint"], "reads": []}]}',
		},
		{
			shape: "a reads entry that is blank",
			text: '{"workflowValidators": [{"command": ["actionlint"], "reads": ["  "]}]}',
		},
	])("refuses the whole list on $shape", ({text}) => {
		expect(readWorkflowValidators(text)._tag).toBe("Unusable");
	});
});
