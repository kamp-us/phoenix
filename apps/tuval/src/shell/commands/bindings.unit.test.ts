/**
 * The dangling-binding gate. A prefix table names commands by string, so nothing in the types stops
 * a binding from naming a row that does not exist — the key would simply do nothing, silently, for
 * as long as nobody pressed it. This is the check that makes that a red test instead.
 */

import {describe, expect, it} from "vitest";
import {applyKeysConfig, CommandName, defaultPrefixTable} from "../keys/index.ts";
import {commandFor} from "./table.ts";

/** Every command name a table binds, in table order. */
const boundNames = (table: typeof defaultPrefixTable): ReadonlyArray<string> =>
	table.bindings.map((binding) => String(binding.command));

/** The bound names no row answers to. Empty is the only passing answer. */
const dangling = (table: typeof defaultPrefixTable): ReadonlyArray<string> =>
	boundNames(table).filter((name) => commandFor(name) === undefined);

describe("the default prefix table against the command table", () => {
	it("binds at least one key, so an empty table cannot pass this file vacuously", () => {
		expect(defaultPrefixTable.bindings.length).toBeGreaterThan(0);
	});

	it("names a row for every binding", () => {
		expect(dangling(defaultPrefixTable)).toEqual([]);
	});

	it("binds only rows a key sequence can drive — no bound row needs an argument", () => {
		const needsArgument = boundNames(defaultPrefixTable).filter((name) => {
			const row = commandFor(name);
			return row !== undefined && Object.keys(row.params.fields).length > 0;
		});
		expect(needsArgument).toEqual([]);
	});
});

describe("a table naming a row that is not there", () => {
	it("is caught, whether the name is a typo or a row nobody wrote", () => {
		const drifted = applyKeysConfig(defaultPrefixTable, {
			bindings: [
				{sequence: "q", command: CommandName.make("window:quit"), repeatable: false},
				{sequence: "w", command: CommandName.make("windo:close"), repeatable: false},
			],
		});
		expect(drifted._tag).toBe("Success");
		expect(drifted._tag === "Success" ? dangling(drifted.success) : null).toEqual([
			"window:quit",
			"windo:close",
		]);
	});
});
