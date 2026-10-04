import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {SHIP_SCOPE, shipScopeKey} from "./ship-scope.ts";

const declared = (config: unknown) =>
	resolve(loadConfig({_tag: "Text", text: JSON.stringify({[SHIP_SCOPE]: config})}), shipScopeKey);

describe("the shipScope key", () => {
	// The containment: a repo that declares nothing keeps the refusal it had before the key existed.
	it("is `refuse` for a repo with no config, and for a declared key that leaves the sub-key out", () => {
		expect(resolve(loadConfig({_tag: "Absent"}), shipScopeKey)).toMatchObject({
			_tag: "Default",
			value: {mainWorkingTree: "refuse"},
		});
		expect(declared({})).toMatchObject({_tag: "Declared", value: {mainWorkingTree: "refuse"}});
	});

	it("refuses a misspelled sub-key whole, rather than reading it as the shipped default", () => {
		expect(declared({mainWorktree: "allow"})).toEqual({
			_tag: "Malformed",
			reason: "`shipScope`'s `mainWorktree` is not a ship-scope setting — one of mainWorkingTree",
		});
	});
});
