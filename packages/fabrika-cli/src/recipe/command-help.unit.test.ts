/**
 * `--help` is the recipe adapter's public contract. `unpark` is the one verb here that takes a lanes
 * root, and it must tell the same derivation story `lane`'s flag tells — a flag advertising a bare
 * cwd-relative default is how an operator learns the wrong resolution rule.
 *
 * The derivation behind each exit lives in the operate skill's `contract.md`, which help points at;
 * the assertions on that derivation read it there.
 */
import {readFileSync} from "node:fs";
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

const CONTRACT = "../../../../claude-plugins/fabrika/skills/operate/contract.md";

/** The contract's `recipe unpark` section, whitespace-collapsed so a rewrap cannot red it. */
const unparkContract = (): string => {
	const text = readFileSync(new URL(CONTRACT, import.meta.url), "utf8");
	const start = text.indexOf("## `recipe unpark`");
	if (start < 0) throw new Error("the operate contract has no `recipe unpark` section");
	const end = text.indexOf("\n## ", start + 1);
	return text.slice(start, end < 0 ? undefined : end).replace(/\s+/g, " ");
};

describe("recipe unpark's repository-root help contract", () => {
	it("advertises the repository-owned --root default the lane group's flag carries", () => {
		const help = flagHelp(leafNamed("unpark"));

		expect(help).toContain("the owning repository's .fabrika/lanes");
		expect(help).toContain("derived off the primary checkout");
		expect(help).not.toContain("(default: .fabrika/lanes)");
	});

	it("seats the no-owning-repository refusal on its own exit and points at the contract", () => {
		const description = leafNamed("unpark").description ?? "";

		expect(description).toContain("\n  11: ");
		expect(description).toContain("\n  39: no owning repository");
		expect(description).toContain('the operate skill\'s contract.md, "recipe unpark"');
		expect(unparkContract()).toContain("derive the default lanes root");
		expect(unparkContract()).toContain("unreadable repository identity is UNKNOWN at `11`");
	});

	// The `parkCause` read is a second derivation off the owning repository, and it refuses on 11
	// alone — a cwd in no repository reads the shipped declaration at itself. A contract claiming
	// 39 for it would send an operator to fix a root the read never touched.
	it("names the owning-repository parkCause read and claims no exit it cannot produce", () => {
		const contract = unparkContract();

		expect(contract).toContain("read from the `.fabrika.jsonc` of the repository that OWNS");
		expect(contract).toContain("`parkCause` read ahead of it never exits here");
	});
});
