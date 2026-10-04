import {describe, expect, it} from "vitest";
import type {CommandNode} from "../unknown-subcommand.ts";
import {graduateCommand} from "./command.ts";

/**
 * Registration is the only route to a verb: a leaf dropped from `withSubcommands` is unreachable
 * from the shell and absent from `fabrika graduate --help`, while every verb test still passes.
 */
describe("the `graduate` group registers each verb", () => {
	const group: CommandNode = graduateCommand;

	it.each(["trail", "compose", "emit", "read"])("resolves `graduate %s` to a leaf", (verb) => {
		const leaf = group.subcommands
			.flatMap((set) => set.commands)
			.find((child) => child.name === verb);
		expect(leaf).toBeDefined();
		expect(leaf?.subcommands.flatMap((set) => set.commands)).toEqual([]);
	});
});
