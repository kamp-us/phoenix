/**
 * `--help` is the recipe adapter's public contract. `unpark` is the one verb here that takes a lanes
 * root, and it must tell the same derivation story `lane`'s flag tells — a flag advertising a bare
 * cwd-relative default is how an operator learns the wrong resolution rule (#7380).
 */
import {describe, expect, it} from "vitest";
import type {CommandNode} from "../unknown-subcommand.ts";
import {recipeCommand} from "./command.ts";

interface FlagNode {
	readonly description?: string | undefined;
	readonly param?: FlagNode | undefined;
}

interface DescribedCommand extends Omit<CommandNode, "subcommands"> {
	readonly description: string | undefined;
	readonly config?: {readonly flags?: ReadonlyArray<FlagNode>} | undefined;
	readonly subcommands: ReadonlyArray<{readonly commands: ReadonlyArray<DescribedCommand>}>;
}

const group: DescribedCommand = recipeCommand;
const leaves = group.subcommands.flatMap((set) => set.commands);

const leafNamed = (name: string): DescribedCommand => {
	const leaf = leaves.find((candidate) => candidate.name === name);
	if (leaf === undefined) throw new Error(`recipe ${name} is not registered`);
	return leaf;
};

/** Every help string on a flag, following the combinator chain to the node that owns the text. */
const flagHelp = (leaf: DescribedCommand): string => {
	const text = (node: FlagNode | undefined): string =>
		node === undefined ? "" : `${node.description ?? ""} ${text(node.param)}`;
	return (leaf.config?.flags ?? []).map(text).join(" ");
};

describe("recipe unpark's repository-root help contract (#7380)", () => {
	it("advertises the repository-owned --root default the lane group's flag carries", () => {
		const help = flagHelp(leafNamed("unpark"));

		expect(help).toContain("the owning repository's .fabrika/lanes");
		expect(help).toContain("derived off the primary checkout");
		expect(help).not.toContain("(default: .fabrika/lanes)");
	});

	it("seats the no-owning-repository refusal on its own exit rather than a lane's absence", () => {
		const description = leafNamed("unpark").description ?? "";

		expect(description).toContain("derive the default lanes root");
		expect(description).toContain("unreadable repository identity is UNKNOWN at 11");
	});
});
