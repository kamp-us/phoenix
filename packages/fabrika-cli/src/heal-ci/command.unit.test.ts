import {describe, expect, it} from "vitest";
import {registeredGroups} from "../registry.ts";
import type {CommandNode} from "../unknown-subcommand.ts";
import {healCiCommand} from "./command.ts";

/**
 * Registration is the only route to a verb: a leaf dropped from `withSubcommands`, or the group
 * dropped from the registry, is unreachable from the shell while every verb test still passes.
 */
describe("the `heal-ci` group registers each verb", () => {
	const group: CommandNode = healCiCommand;

	it("is a group the root command registers", () => {
		expect(registeredGroups).toContain(healCiCommand);
	});

	it.each([
		"diagnose",
		"sweep",
		"surface",
		"logs",
		"classify",
		"rerun",
		"note",
		"scratch",
	])("resolves `heal-ci %s` to a leaf", (verb) => {
		const leaf = group.subcommands
			.flatMap((set) => set.commands)
			.find((child) => child.name === verb);
		expect(leaf).toBeDefined();
		expect(leaf?.subcommands.flatMap((set) => set.commands)).toEqual([]);
	});
});
