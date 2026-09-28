import {describe, expect, it} from "vitest";
import type {CommandNode} from "../unknown-subcommand.ts";
import {uiCommand} from "./command.ts";

/**
 * Registration is the only route to a verb: a leaf dropped from `withSubcommands` is unreachable
 * from the shell and absent from `fabrika ui --help`, while every verb test still passes.
 */
describe("the `ui` group registers each verb", () => {
	const group: CommandNode = uiCommand;

	it.each([
		"manifest",
		"law",
		"render",
		"golden",
		"evidence",
	])("resolves `ui %s` to a leaf", (verb) => {
		const leaf = group.subcommands
			.flatMap((set) => set.commands)
			.find((child) => child.name === verb);
		expect(leaf).toBeDefined();
		expect(leaf?.subcommands.flatMap((set) => set.commands)).toEqual([]);
	});
});
