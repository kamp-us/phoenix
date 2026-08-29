/**
 * `--help` is the lane adapter's public contract. Keep every repository-rooted verb aligned with
 * the derivation and refusal semantics in ground.ts rather than preserving the old cwd-relative
 * story on commands that happen not to exercise that branch in their verb unit tests (#5815).
 */
import {describe, expect, it} from "vitest";
import type {CommandNode} from "../unknown-subcommand.ts";
import {laneCommand} from "./command.ts";
import {PARK_CAUSE_TOKENS} from "./report.ts";

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

const group: DescribedCommand = laneCommand;
const leaves = group.subcommands.flatMap((set) => set.commands);
const ROOTED_VERBS = [
	"status",
	"transition",
	"report",
	"prove",
	"history",
	"print",
	"open",
	"emit",
	"assembly",
	"push",
	"brief",
	"stale",
	"migrate",
	"view",
] as const;

const leafNamed = (name: string): DescribedCommand => {
	const leaf = leaves.find((candidate) => candidate.name === name);
	if (leaf === undefined) throw new Error(`lane ${name} is not registered`);
	return leaf;
};

/** Every help string on a flag, following the combinator chain to the node that owns the text. */
const flagHelp = (leaf: DescribedCommand): string => {
	const text = (node: FlagNode | undefined): string =>
		node === undefined ? "" : `${node.description ?? ""} ${text(node.param)}`;
	return (leaf.config?.flags ?? []).map(text).join(" ");
};

describe("the lane group's repository-root help contract (#5815)", () => {
	it.each(
		ROOTED_VERBS,
	)("lane %s describes repository derivation and both refusal seats", (name) => {
		const description = leafNamed(name).description ?? "";

		expect(description).toContain("owning repository");
		expect(description).toContain("derive the default lanes root");
		expect(description).toContain("unreadable repository identity is UNKNOWN at 11");
		expect(description).not.toContain("neither .fabrika nor .git");
		expect(description).not.toContain("relative lanes root");
	});

	it.each(ROOTED_VERBS)("lane %s advertises the shared repository-owned --root default", (name) => {
		const help = flagHelp(leafNamed(name));

		expect(help).toContain("the owning repository's .fabrika/lanes");
		expect(help).toContain("derived off the primary checkout");
	});
});

describe("the closed park-cause set --cause advertises", () => {
	// The listing is what an operator reads before parking, so a token missing from it is a token
	// nobody names — and a `BLOCKED` carrying no cause is Novel forever (#6480, #7217).
	it.each(PARK_CAUSE_TOKENS)("lane transition --cause offers %s", (token) => {
		expect(flagHelp(leafNamed("transition"))).toContain(token);
	});

	it("offers spawn-dead beside the three tokens that predate it", () => {
		expect([...PARK_CAUSE_TOKENS]).toEqual([
			"campaign-paused",
			"head-behind-base",
			"spawn-dead",
			"worktree-holds-branch",
		]);
	});
});
