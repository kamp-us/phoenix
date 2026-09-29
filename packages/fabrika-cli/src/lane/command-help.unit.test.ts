/**
 * `--help` is the lane adapter's public contract. Keep every repository-rooted verb aligned with
 * the derivation and refusal semantics in ground.ts rather than preserving the old cwd-relative
 * story on commands that happen not to exercise that branch in their verb unit tests.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import type {CommandNode} from "../unknown-subcommand.ts";
import {laneCommand} from "./command.ts";
import {LANE_CONTRACT, ROOT_EXITS} from "./help.ts";
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
/** Rooted verbs whose help is on the leaf help rule; the lanes-root derivation is in the contract. */
const MIGRATED_ROOTED_VERBS = [
	"status",
	"transition",
	"report",
	"prove",
	"history",
	"print",
	"open",
	"emit",
	"amend",
	"brief",
	"dispatch",
	"assembly",
	"integrate",
	"refresh",
	"push",
	"stale",
	"attach-integrate",
	"seats",
	"migrate",
	"reconcile",
	"recover",
	"archive",
	"settle",
] as const;

/** Every verb whose help points at the operate contract, and so needs its section there. */
const CONTRACT_VERBS = [
	...MIGRATED_ROOTED_VERBS,
	"clear",
	"assembly-pr",
	"assembly-body",
	"retrigger",
	"claim",
	"release",
	"adopt",
	"scratch",
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

describe("the lane group's repository-root help contract", () => {
	it.each(
		MIGRATED_ROOTED_VERBS,
	)("lane %s names both lanes-root refusals on its own exit lines", (name) => {
		const lines = (leafNamed(name).description ?? "").split("\n");

		expect(lines).toContain(`  39: ${ROOT_EXITS[39]}`);
		expect(lines).toContain(`  65: ${ROOT_EXITS[65]}`);
	});

	it.each(
		MIGRATED_ROOTED_VERBS,
	)("lane %s advertises the shared repository-owned --root default", (name) => {
		const help = flagHelp(leafNamed(name));

		expect(help).toContain("the owning repository's .fabrika/lanes");
		expect(help).toContain("derived off the primary checkout");
	});
});

describe("the operate contract the migrated lane help points at", () => {
	const contract = readFileSync(
		fileURLToPath(new URL(`../../../../${LANE_CONTRACT}`, import.meta.url)),
		"utf8",
	);

	it.each(CONTRACT_VERBS)("lane %s has the section its help pointer names", (name) => {
		expect(leafNamed(name).description).toContain(`"lane ${name}"`);
		expect(contract.split("\n")).toContain(`## \`lane ${name}\``);
	});

	it("carries the lanes-root derivation the exit lines no longer state", () => {
		expect(contract).toContain("An unreadable repository identity is UNKNOWN at `11`.");
	});
});

describe("the closed park-cause set --cause advertises", () => {
	// The listing is what an operator reads before parking, so a token missing from it is a token
	// nobody names — and a `BLOCKED` carrying no cause is Novel forever.
	it.each(PARK_CAUSE_TOKENS)("lane transition --cause offers %s", (token) => {
		expect(flagHelp(leafNamed("transition"))).toContain(token);
	});

	it("offers the two spent-budget parks, the two base machinery causes, the queue ejection, the red head, the rendered gate's four, the unlanded write, the builder's two mechanical stops, the owner-approval wait and the size stop beside the six that predate them", () => {
		expect([...PARK_CAUSE_TOKENS]).toEqual([
			"assembly-conflict",
			"awaiting-cp-approval",
			"base-conflicted",
			"claim-stranded",
			"head-behind-base",
			"head-ci-red",
			"no-design-manifest",
			"no-preview-render",
			"no-preview-routed",
			"no-rendered-delta",
			"queue-ejected",
			"repair-budget-spent",
			"replay-budget-spent",
			"replay-conflict",
			"size-stop",
			"spawn-dead",
			"tree-hijacked",
			"worktree-holds-branch",
			"write-unlanded",
		]);
	});
});
