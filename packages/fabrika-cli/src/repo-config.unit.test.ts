import {describe, expect, it} from "vitest";
import {
	readCapClearAuthors,
	readDocLeakExempt,
	readWorkflowValidators,
	stripJsonComments,
} from "./repo-config.ts";

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

describe("readCapClearAuthors", () => {
	it("reads users and teams, both `@`-prefixed as GitHub writes them", () => {
		const read = readCapClearAuthors('{"capClearAuthors": ["@usirin", "@kamp-us/control-plane"]}');
		expect(read).toEqual({
			_tag: "Authors",
			authors: [
				{_tag: "User", login: "usirin"},
				{_tag: "Team", org: "kamp-us", team: "control-plane"},
			],
		});
	});

	it("reads through comments, which is the whole point of the `.jsonc` home", () => {
		const read = readCapClearAuthors(
			'{\n\t// the founder accounts\n\t"capClearAuthors": ["@a"]\n}',
		);
		expect(read._tag).toBe("Authors");
	});

	/** Every one of these is "nobody may grant" — never a default set, never a silent skip. */
	it.each([
		{shape: "no file content at all", text: ""},
		{shape: "a document that is not an object", text: "[]"},
		{shape: "no key", text: '{"other": 1}'},
		{shape: "a key that is not an array", text: '{"capClearAuthors": "@usirin"}'},
		{shape: "an empty array", text: '{"capClearAuthors": []}'},
		{shape: "a non-string entry", text: '{"capClearAuthors": [1]}'},
		{shape: "an entry with no `@`", text: '{"capClearAuthors": ["usirin"]}'},
		{shape: "an entry naming a nested path", text: '{"capClearAuthors": ["@a/b/c"]}'},
	])("refuses the whole set on $shape", ({text}) => {
		expect(readCapClearAuthors(text)._tag).toBe("Unusable");
	});
});

describe("readWorkflowValidators", () => {
	it("reads each declared command as an argv, in declaration order", () => {
		expect(
			readWorkflowValidators(
				'{"workflowValidators": [["node", "guards/bin.js", "check"], ["lint-workflows"]]}',
			),
		).toEqual({
			_tag: "Validators",
			commands: [["node", "guards/bin.js", "check"], ["lint-workflows"]],
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
		{shape: "an empty argv", text: '{"workflowValidators": [[]]}'},
		{shape: "an argv holding a non-string", text: '{"workflowValidators": [["node", 7]]}'},
	])("refuses the whole list on $shape", ({text}) => {
		expect(readWorkflowValidators(text)._tag).toBe("Unusable");
	});
});
