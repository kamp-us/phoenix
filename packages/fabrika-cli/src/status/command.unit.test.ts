import {describe, expect, it} from "vitest";
import {registeredGroups} from "../registry.ts";
import type {CommandNode} from "../unknown-subcommand.ts";
import {statusCommand} from "./command.ts";

/**
 * Registration is the only route to a verb: a leaf dropped from `withSubcommands`, or the group
 * dropped from the registry, is unreachable from the shell while every verb test still passes.
 */
describe("the `status` group registers each verb", () => {
	const group: CommandNode = statusCommand;

	it("is a group the root command registers", () => {
		expect(registeredGroups).toContain(statusCommand);
	});

	it.each([
		"open",
		"settings",
		"wiring",
		"menu",
		"readout",
		"board",
		"bootstrap",
	])("resolves `status %s` to a leaf", (verb) => {
		const leaf = group.subcommands
			.flatMap((set) => set.commands)
			.find((child) => child.name === verb);
		expect(leaf).toBeDefined();
		expect(leaf?.subcommands.flatMap((set) => set.commands)).toEqual([]);
	});
});
