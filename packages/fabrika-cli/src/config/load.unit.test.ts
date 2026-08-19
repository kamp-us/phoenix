import {describe, expect, it} from "vitest";
import {CONFIG_PATH} from "./document.ts";
import type {KeyGroup, Registration} from "./key-group.ts";
import {capClearAuthorsKey} from "./keys/cap-clear-authors.ts";
import {docLeakExemptKey} from "./keys/doc-leak-exempt.ts";
import {governedRootsKey, SHIPPED_GOVERNED_ROOTS} from "./keys/governed-roots.ts";
import {workflowValidatorsKey} from "./keys/workflow-validators.ts";
import {type Load, loadConfig, resolve} from "./load.ts";
import {KEY_GROUPS} from "./registry.ts";

const fromText = (text: string): Load => loadConfig({_tag: "Text", text});

/** Every registered key, so an arm that must hold for all of them is asserted over all of them. */
const registered: Array<[string, Registration]> = KEY_GROUPS.map((group) => [group.key, group]);

describe("the four resolution arms", () => {
	it.each(registered)("%s resolves to its shipped default with no file at all", (_key, group) => {
		const load = loadConfig({_tag: "Absent"});
		expect(load._tag).toBe("Config");
		if (load._tag !== "Config") return;
		const resolved = group.resolve(load.state);
		expect(resolved._tag).toBe("Default");
	});

	it.each(registered)("%s resolves to its shipped default with no key declared", (_key, group) => {
		const load = fromText('{"somethingElse": 1}');
		expect(load._tag).toBe("Config");
		if (load._tag !== "Config") return;
		expect(group.resolve(load.state)._tag).toBe("Default");
	});

	it.each(registered)("%s is UNKNOWN when the file exists and cannot be read", (_key, group) => {
		const load = loadConfig({_tag: "Unreadable", reason: "EACCES"});
		expect(load._tag).toBe("Config");
		if (load._tag !== "Config") return;
		const resolved = group.resolve(load.state);
		expect(resolved).toEqual({_tag: "Unknown", reason: "EACCES"});
	});

	it.each(registered)("%s refuses a document that is not a JSON object", (_key, group) => {
		const load = fromText("[]");
		expect(load._tag).toBe("Config");
		if (load._tag !== "Config") return;
		expect(group.resolve(load.state)).toEqual({
			_tag: "Malformed",
			reason: `${CONFIG_PATH} is not a JSON object with comments`,
		});
	});
});

/** The declared arm, per key, read through the same load. */
describe("declared values", () => {
	const declared = <A>(text: string, group: KeyGroup<A>) => resolve(fromText(text), group);

	it("reads users and teams, both `@`-prefixed as GitHub writes them", () => {
		expect(
			declared('{"capClearAuthors": ["@usirin", "@kamp-us/control-plane"]}', capClearAuthorsKey),
		).toEqual({
			_tag: "Declared",
			value: [
				{_tag: "User", login: "usirin"},
				{_tag: "Team", org: "kamp-us", team: "control-plane"},
			],
		});
	});

	it("reads through comments, which is the whole point of the `.jsonc` home", () => {
		expect(
			declared('{\n\t// the founder accounts\n\t"capClearAuthors": ["@a"]\n}', capClearAuthorsKey)
				._tag,
		).toBe("Declared");
	});

	it("reads exempt paths trimmed, in declaration order", () => {
		expect(
			declared('{"docLeakExempt": [" /CLAUDE.md ", "/agents/triager.md"]}', docLeakExemptKey),
		).toEqual({_tag: "Declared", value: ["/CLAUDE.md", "/agents/triager.md"]});
	});

	it("reads each validator with the files it opens", () => {
		expect(
			declared(
				'{"workflowValidators": [{"command": ["node", "b.js"], "reads": [".github/workflows/ci.yml"]}]}',
				workflowValidatorsKey,
			),
		).toEqual({
			_tag: "Declared",
			value: [{argv: ["node", "b.js"], reads: [".github/workflows/ci.yml"]}],
		});
	});

	it("reads governed roots, and the default is phoenix's roots plus the config file", () => {
		expect(SHIPPED_GOVERNED_ROOTS).toContain(CONFIG_PATH);
		expect(
			declared(`{"governedRoots": [".decisions/", "${CONFIG_PATH}"]}`, governedRootsKey),
		).toEqual({_tag: "Declared", value: [".decisions/", CONFIG_PATH]});
	});
});

/** A malformed value refuses that key's whole value, naming what it rejected. */
describe("malformed values", () => {
	it.each([
		{shape: "a key that is not an array", text: '{"capClearAuthors": "@usirin"}'},
		{shape: "a non-string entry", text: '{"capClearAuthors": [1]}'},
		{shape: "an entry with no `@`", text: '{"capClearAuthors": ["usirin"]}'},
		{shape: "an entry naming a nested path", text: '{"capClearAuthors": ["@a/b/c"]}'},
	])("capClearAuthors refuses the whole set on $shape", ({text}) => {
		const resolved = resolve(fromText(text), capClearAuthorsKey);
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag === "Malformed") expect(resolved.reason).toContain("capClearAuthors");
	});

	it.each([
		{shape: "a key that is not an array", text: '{"docLeakExempt": "/CLAUDE.md"}'},
		{shape: "a non-string entry", text: '{"docLeakExempt": [1]}'},
		{shape: "a blank entry", text: '{"docLeakExempt": ["  "]}'},
	])("docLeakExempt refuses the whole list on $shape", ({text}) => {
		expect(resolve(fromText(text), docLeakExemptKey)._tag).toBe("Malformed");
	});

	it.each([
		{shape: "a key that is not an array", text: '{"workflowValidators": "actionlint"}'},
		{shape: "an entry that is a bare string", text: '{"workflowValidators": ["actionlint"]}'},
		{shape: "a bare argv", text: '{"workflowValidators": [["actionlint"]]}'},
		{shape: "an empty argv", text: '{"workflowValidators": [{"command": [], "reads": ["a.yml"]}]}'},
		{shape: "no reads key", text: '{"workflowValidators": [{"command": ["actionlint"]}]}'},
		{
			shape: "an empty reads list",
			text: '{"workflowValidators": [{"command": ["actionlint"], "reads": []}]}',
		},
	])("workflowValidators refuses the whole list on $shape", ({text}) => {
		expect(resolve(fromText(text), workflowValidatorsKey)._tag).toBe("Malformed");
	});

	it("governedRoots refuses an empty list rather than reading it as `nothing is governed`", () => {
		const resolved = resolve(fromText('{"governedRoots": []}'), governedRootsKey);
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag === "Malformed")
			expect(resolved.reason).toContain("nothing would be governed");
	});
});

describe("a config cannot un-govern itself", () => {
	it("refuses the whole load, naming the key, when the roots do not cover the config file", () => {
		const load = fromText('{"governedRoots": [".decisions/"]}');
		expect(load._tag).toBe("Refused");
		if (load._tag !== "Refused") return;
		expect(load.reason).toContain("governedRoots");
		expect(load.reason).toContain(CONFIG_PATH);
	});

	it("refuses every key off that load, so no value is read out of a refused config", () => {
		const load = fromText('{"governedRoots": [".decisions/"], "capClearAuthors": ["@a"]}');
		expect(resolve(load, capClearAuthorsKey)._tag).toBe("Malformed");
	});

	it("admits a declared root list that covers the config file", () => {
		expect(fromText(`{"governedRoots": ["${CONFIG_PATH}"]}`)._tag).toBe("Config");
	});

	it("admits the shipped default, which covers it", () => {
		expect(fromText("{}")._tag).toBe("Config");
		expect(loadConfig({_tag: "Absent"})._tag).toBe("Config");
	});

	it("does not refuse on an unreadable file — that is UNKNOWN, not a bad config", () => {
		expect(loadConfig({_tag: "Unreadable", reason: "EIO"})._tag).toBe("Config");
	});

	it.each([
		{shape: "an empty list", text: '{"governedRoots": []}', words: "nothing would be governed"},
		{shape: "a value that is not an array", text: '{"governedRoots": 42}', words: "not an array"},
	])("refuses the whole load on $shape, in the decoder's words", ({text, words}) => {
		const load = fromText(text);
		expect(load._tag).toBe("Refused");
		if (load._tag !== "Refused") return;
		expect(load.reason).toContain("governedRoots");
		expect(load.reason).toContain(words);
	});

	it("refuses every key off a malformed-value load, the same as a too-narrow one", () => {
		expect(
			resolve(fromText('{"governedRoots": [], "capClearAuthors": ["@a"]}'), capClearAuthorsKey)
				._tag,
		).toBe("Malformed");
	});

	it("does not refuse on a document that is not a JSON object — every key is already malformed", () => {
		const load = fromText("[]");
		expect(load._tag).toBe("Config");
		expect(resolve(load, governedRootsKey)._tag).toBe("Malformed");
	});

	it("leaves a malformed key that raises no load refusal to its own key", () => {
		const load = fromText('{"docLeakExempt": [7]}');
		expect(load._tag).toBe("Config");
		expect(resolve(load, docLeakExemptKey)._tag).toBe("Malformed");
	});
});

describe("the registry", () => {
	it("registers every key exactly once", () => {
		const keys = KEY_GROUPS.map((group) => group.key);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
