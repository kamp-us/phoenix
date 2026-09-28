import {describe, expect, it} from "vitest";
import type {CommandNode} from "../unknown-subcommand.ts";
import {ledgerCommand} from "./command.ts";

/**
 * Registration is the only route to a verb: a leaf dropped from `withSubcommands` is unreachable
 * from the shell and absent from `fabrika ledger --help`, while every verb test still passes.
 */
describe("the `ledger` group registers each verb", () => {
	const group: CommandNode = ledgerCommand;

	it.each([
		"open",
		"draft",
		"child",
		"adopt",
		"topology",
		"write",
		"edges",
		"defer",
		"supersede",
		"retopology",
		"digest",
	])("resolves `ledger %s` to a leaf", (verb) => {
		const leaf = group.subcommands
			.flatMap((set) => set.commands)
			.find((child) => child.name === verb);
		expect(leaf).toBeDefined();
		expect(leaf?.subcommands.flatMap((set) => set.commands)).toEqual([]);
	});
});
