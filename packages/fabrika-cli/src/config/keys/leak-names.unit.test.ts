import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {LEAK_NAMES, leakNamesKey, NO_LEAK_NAMES} from "./leak-names.ts";

const declared = (value: unknown) =>
	resolve(loadConfig({_tag: "Text", text: JSON.stringify({[LEAK_NAMES]: value})}), leakNamesKey);

describe("leakNames", () => {
	it("ships both lists empty — no repo, person or number is a default", () => {
		expect(NO_LEAK_NAMES).toEqual({privateRepos: [], identifiers: []});
		expect(resolve(loadConfig({_tag: "Absent"}), leakNamesKey)).toMatchObject({
			_tag: "Default",
			value: NO_LEAK_NAMES,
		});
	});

	it("decodes both lists, trimmed", () => {
		expect(declared({privateRepos: [" acme/secret "], identifiers: ["Jane Roe"]})).toEqual({
			_tag: "Declared",
			value: {privateRepos: ["acme/secret"], identifiers: ["Jane Roe"]},
		});
	});

	it("reads an absent list as empty", () => {
		expect(declared({identifiers: ["handle"]})).toEqual({
			_tag: "Declared",
			value: {privateRepos: [], identifiers: ["handle"]},
		});
	});

	it.each([
		["not an object", ["acme/secret"], "is not an object"],
		["a stray sub-key", {repos: []}, "`repos` is not a leak-name list"],
		["a list that is not an array", {identifiers: "handle"}, "`identifiers` is not an array"],
		["an empty entry", {identifiers: [" "]}, "`identifiers` is not an array"],
		["a slug with no owner", {privateRepos: ["secret"]}, '"secret", which is not an `owner/repo`'],
		[
			"a URL instead of a slug",
			{privateRepos: ["https://github.com/acme/secret"]},
			"not an `owner/repo`",
		],
		["a dot-path repo", {privateRepos: ["acme/.."]}, "not an `owner/repo`"],
	])("refuses the whole value on %s", (_name, value, reason) => {
		const resolved = declared(value);
		expect(resolved._tag).toBe("Malformed");
		expect(resolved._tag === "Malformed" && resolved.reason).toContain(reason);
	});
});
