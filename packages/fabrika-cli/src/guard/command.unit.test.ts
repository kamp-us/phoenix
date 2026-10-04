import {describe, expect, it} from "vitest";
import type {CommandNode} from "../unknown-subcommand.ts";
import {guardCommand} from "./command.ts";

const childOf = (node: CommandNode | undefined, name: string): CommandNode | undefined =>
	node?.subcommands.flatMap((set) => set.commands).find((child) => child.name === name);

/**
 * Registration is the only route to a guard: a row dropped from the registry is unreachable from a
 * workflow step, while its verb test still passes. The other leaves are walked in
 * `unknown-subcommand.unit.test.ts`.
 */
describe("the `guard` group registers skill-lint", () => {
	it("resolves `guard skill-lint check` to a leaf", () => {
		const leaf = childOf(childOf(guardCommand, "skill-lint"), "check");
		expect(leaf).toBeDefined();
		expect(leaf?.subcommands.flatMap((set) => set.commands)).toEqual([]);
	});
});
