import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {KEY_GROUPS} from "../registry.ts";
import {CONFIG_VALIDATORS, configValidatorsKey} from "./config-validators.ts";
import {workflowValidatorsKey} from "./workflow-validators.ts";

const declared = (value: unknown) =>
	resolve(
		loadConfig({_tag: "Text", text: JSON.stringify({[CONFIG_VALIDATORS]: value})}),
		configValidatorsKey,
	);

const LEFTHOOK = {command: ["pnpm", "exec", "lefthook", "validate"], reads: ["lefthook.yml"]};

describe("configValidators", () => {
	it("is registered, so `.fabrika.jsonc` accepts it", () => {
		expect(KEY_GROUPS.map((group) => group.key)).toContain(CONFIG_VALIDATORS);
	});

	it("ships the empty list", () => {
		const resolved = resolve(loadConfig({_tag: "Absent"}), configValidatorsKey);
		expect(resolved).toMatchObject({_tag: "Default", value: []});
	});

	it("decodes an entry into the argv to spawn and the exact files it reads", () => {
		expect(declared([LEFTHOOK])).toEqual({
			_tag: "Declared",
			layer: "tracked",
			value: [{argv: ["pnpm", "exec", "lefthook", "validate"], reads: ["lefthook.yml"]}],
		});
	});

	it("decodes by the same rules workflowValidators uses", () => {
		const text = JSON.stringify({
			[CONFIG_VALIDATORS]: [LEFTHOOK],
			workflowValidators: [LEFTHOOK],
		});
		const load = loadConfig({_tag: "Text", text});
		expect(resolve(load, configValidatorsKey)).toEqual(resolve(load, workflowValidatorsKey));
	});

	it.each([
		{shape: "a glob in reads", value: [{command: ["lint"], reads: ["config/*.yml"]}]},
		{shape: "a character class in reads", value: [{command: ["lint"], reads: ["[ab].yml"]}]},
		{shape: "a brace set in reads", value: [{command: ["lint"], reads: ["{a,b}.yml"]}]},
		{shape: "a non-string in reads", value: [{command: ["lint"], reads: ["a.yml", 7]}]},
		{shape: "an empty command", value: [{command: [], reads: ["a.yml"]}]},
		{shape: "an empty reads", value: [{command: ["lint"], reads: []}]},
		{shape: "no reads key", value: [{command: ["lint"]}]},
		{shape: "a key that is not an array", value: "lefthook validate"},
	])("refuses the whole list on $shape, as workflowValidators refuses", ({value}) => {
		const resolved = declared(value);
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain(`\`${CONFIG_VALIDATORS}\``);
	});

	it("names the pattern it refused", () => {
		expect(declared([{command: ["lint"], reads: ["a.yml", "config/*.yml"]}])).toEqual({
			_tag: "Malformed",
			reason:
				'`configValidators` reads "config/*.yml", a pattern — `reads` names exact repo-relative paths, never a glob',
		});
	});
});
