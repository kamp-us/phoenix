/**
 * `--help` is the interface (`claude-plugins/fabrika/docs/cli-interface-convention.md` §1), so what
 * it must state is asserted rather than trusted: what the verb answers, the shape of its stdout,
 * the codes it can exit on, and one literal invocation a caller can paste.
 *
 * It reads the description and the declared flags off the `Command`'s runtime shape, the same
 * deliberately-confined idiom `../excess-operand.unit.test.ts` uses — a plain widening assignment,
 * never a cast, so a rename upstream reds here at build time rather than leaving the assertions
 * silently vacuous.
 */
import {describe, expect, it} from "vitest";
import type {CommandNode} from "../unknown-subcommand.ts";
import {wireCommand} from "./command.ts";
import {registeredKeys} from "./registry.ts";

/** A flag as this test reads it: a combinator chain over a `Single` carrying the help text. */
interface FlagNode {
	readonly description?: string | undefined;
	readonly param?: FlagNode | undefined;
}

interface DescribedCommand extends Omit<CommandNode, "subcommands"> {
	readonly description: string | undefined;
	readonly config?: {readonly flags?: ReadonlyArray<FlagNode>} | undefined;
	readonly subcommands: ReadonlyArray<{readonly commands: ReadonlyArray<DescribedCommand>}>;
}

const group: DescribedCommand = wireCommand;
const leaves = group.subcommands.flatMap((set) => set.commands);
const LEAF_NAMES = ["codes", "formats", "emit", "read", "check", "index"];

const describedBy = (name: string): string =>
	leaves.find((leaf) => leaf.name === name)?.description ?? "";

/** Every help string on a flag, following the combinator chain down to the `Single` that holds it. */
const flagHelp = (name: string): string => {
	const text = (node: FlagNode | undefined): string =>
		node === undefined ? "" : `${node.description ?? ""} ${text(node.param)}`;
	const leaf = leaves.find((candidate) => candidate.name === name);
	return (leaf?.config?.flags ?? []).map(text).join(" ");
};

describe("the wire group's help", () => {
	it("registers the flat leaves and no sub-group", () => {
		expect(leaves.map((leaf) => leaf.name)).toEqual(LEAF_NAMES);
		for (const leaf of leaves) expect(leaf.subcommands.flatMap((set) => set.commands)).toEqual([]);
	});

	it("gives the group itself a one-line description, so `fabrika --help` lists it", () => {
		expect(group.description ?? "").not.toBe("");
	});

	it.each(LEAF_NAMES)("%s states its exit codes and a literal example invocation", (name) => {
		const description = describedBy(name);
		expect(description).not.toBe("");
		expect(description).toMatch(/[Ee]xits? \d|always exits 0/);
		expect(description).toContain(`Example: fabrika wire ${name}`);
	});

	it("states the stdout shape for every verb that prints one", () => {
		for (const name of ["codes", "formats", "read", "check", "index"]) {
			expect(describedBy(name)).toMatch(/stdout/i);
		}
	});

	it("advertises the --format vocabulary from the registry, never from a literal", () => {
		for (const name of ["emit", "read", "check"]) {
			const advertised = flagHelp(name);
			expect(advertised).not.toBe("");
			for (const key of registeredKeys()) expect(advertised).toContain(key);
		}
	});
});
