import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {OWN_ACCOUNTS, ownAccountsKey} from "./own-accounts.ts";

const declared = (value: unknown) =>
	resolve(
		loadConfig({_tag: "Text", text: JSON.stringify({[OWN_ACCOUNTS]: value})}),
		ownAccountsKey,
	);

describe("ownAccounts", () => {
	it("decodes to the empty set when the file is absent", () => {
		expect(resolve(loadConfig({_tag: "Absent"}), ownAccountsKey)).toMatchObject({
			_tag: "Default",
			value: [],
		});
	});

	it("decodes a declared empty array as the empty set", () => {
		expect(declared([])).toEqual({_tag: "Declared", layer: "tracked", value: []});
	});

	it("decodes a populated set of users and teams", () => {
		expect(declared(["@ada-bot", "@acme/drivers"])).toEqual({
			_tag: "Declared",
			layer: "tracked",
			value: [
				{_tag: "User", login: "ada-bot"},
				{_tag: "Team", org: "acme", team: "drivers"},
			],
		});
	});

	it.each([
		["not an array", "@ada-bot", "is not an array"],
		["a bare login", ["ada-bot"], "is not a `ownAccounts` entry"],
		["a non-string entry", [7], "non-string entry"],
	])("refuses the whole value on %s", (_name, value, reason) => {
		const resolved = declared(value);
		expect(resolved._tag).toBe("Malformed");
		expect(resolved._tag === "Malformed" && resolved.reason).toContain(reason);
	});

	it("carries an entry pattern that agrees with the decoder", () => {
		const pattern = new RegExp(ownAccountsKey.jsonSchema?.items?.pattern ?? "(?!)");
		for (const entry of ["@ada", "@acme/drivers", "ada", "@", "@a/b/c"]) {
			expect(pattern.test(entry)).toBe(ownAccountsKey.decode([entry])._tag === "Value");
		}
	});
});
