import {existsSync, readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {
	type DescribedNode,
	describeFinding,
	LEAF_HELP_BASELINE_FILE,
	LEAF_HELP_BUDGET,
	LEAF_HELP_LINE_BUDGET,
	type LeafHelp,
	type LeafHelpBaseline,
	leafHelpDefects,
	leafHelpRatchet,
	leafHelpWalk,
} from "./leaf-help.ts";
import {registeredGroups} from "./registry.ts";

/** The rule's own worked example for `build eligible`, which the convention states passes. */
const COMPLIANT = [
	'Prints {"answer":"eligible","number":n,"parent":n|null} when one issue\'s dependency gate is open.',
	"  7: the issue is absent or closed",
	"  11: a read failed and nothing was proven open (UNKNOWN)",
	"  16: blocked; every open edge is named on stderr",
	'  Derivation: the build skill\'s contract.md, "build eligible"',
].join("\n");

describe("leafHelpDefects", () => {
	it("passes the rule's own compliant example", () => {
		expect(leafHelpDefects(COMPLIANT)).toEqual([]);
	});

	it("names an absent description rather than passing it", () => {
		expect(leafHelpDefects(undefined)).toHaveLength(1);
		expect(leafHelpDefects("  ")).toHaveLength(1);
	});

	it("reds on a description over the whole budget", () => {
		const text = ["Does a thing.", ...Array.from({length: 8}, () => `  ${"x".repeat(80)}`)].join(
			"\n",
		);
		expect(text.length).toBeGreaterThan(LEAF_HELP_BUDGET);
		expect(leafHelpDefects(text)).toEqual([
			`${text.length} characters, over the ${LEAF_HELP_BUDGET}-character budget`,
		]);
	});

	it("reds on a line over the line budget", () => {
		expect(leafHelpDefects(`${"x".repeat(LEAF_HELP_LINE_BUDGET)}.`)).toEqual([
			`summary line is ${LEAF_HELP_LINE_BUDGET + 1} characters, over the ${LEAF_HELP_LINE_BUDGET}-character line budget`,
		]);
		expect(leafHelpDefects(`Does a thing.\n  ${"x".repeat(LEAF_HELP_LINE_BUDGET + 1)}`)).toEqual([
			`line 2 is ${LEAF_HELP_LINE_BUDGET + 1} characters, over the ${LEAF_HELP_LINE_BUDGET}-character line budget`,
		]);
	});

	it("reds on a summary that is not one sentence ending in a full stop", () => {
		expect(leafHelpDefects("Does a thing. Then another.")).toHaveLength(1);
		expect(leafHelpDefects("Does a thing")).toHaveLength(1);
	});

	it("reds on a later line without the two-space indent", () => {
		expect(leafHelpDefects("Does a thing.\n3: not found")).toEqual([
			"line 2 does not carry the two-space indent",
		]);
	});

	it("reds on Example: prose and on exit codes stated in prose", () => {
		expect(leafHelpDefects("Does a thing, Example: fabrika adr next.")).toHaveLength(1);
		expect(leafHelpDefects("Does a thing and exits 3 when absent.")).toHaveLength(1);
	});

	it("reds on exit lines for 0 or 1 and on exit lines out of order", () => {
		expect(leafHelpDefects("Does a thing.\n  0: done")).toEqual([
			"gives 0 or 1 an exit line — every verb shares those",
		]);
		expect(leafHelpDefects("Does a thing.\n  11: unknown\n  7: absent")).toEqual([
			"exit lines are not in ascending order",
		]);
	});
});

const BAD = "Does a thing. Exits 3 when absent.";
const leaf = (verb: string, description: string): LeafHelp => ({group: "g", verb, description});
const baselines = (rows: LeafHelpBaseline) => new Map([["g", rows]]);

describe("leafHelpRatchet", () => {
	it("passes a compliant verb with no baseline row and a baselined verb held at its length", () => {
		expect(
			leafHelpRatchet([leaf("ok", COMPLIANT), leaf("old", BAD)], baselines({old: BAD.length})),
		).toEqual([]);
	});

	it("reds a verb that breaks the rule and is not in its group's baseline", () => {
		expect(leafHelpRatchet([leaf("new", BAD)], baselines({}))).toEqual([
			{kind: "unbaselined", group: "g", verb: "new", defects: leafHelpDefects(BAD)},
		]);
	});

	it("reds a baseline verb whose description grew past its recorded length", () => {
		expect(leafHelpRatchet([leaf("old", BAD)], baselines({old: BAD.length - 1}))).toEqual([
			{kind: "grew", group: "g", verb: "old", length: BAD.length, recorded: BAD.length - 1},
		]);
	});

	it("reds a baseline row whose verb now passes the rule", () => {
		expect(leafHelpRatchet([leaf("fixed", COMPLIANT)], baselines({fixed: 900}))).toEqual([
			{kind: "stale", group: "g", verb: "fixed"},
		]);
	});

	it("reds a baseline row naming no registered verb", () => {
		expect(leafHelpRatchet([leaf("ok", COMPLIANT)], baselines({gone: 900}))).toEqual([
			{kind: "unknown-verb", group: "g", verb: "gone"},
		]);
	});

	it("fails closed when the walk found zero leaves", () => {
		expect(leafHelpRatchet([], baselines({}))).toEqual([{kind: "no-leaves"}]);
	});
});

describe("leafHelpWalk", () => {
	it("keys a nested leaf by its path below the group", () => {
		const node = (name: string, ...children: Array<DescribedNode>): DescribedNode => ({
			name,
			description: `${name}.`,
			subcommands: children.length === 0 ? [] : [{commands: children}],
		});
		expect(
			leafHelpWalk([node("build", node("claim"), node("claims", node("stale")))]).map(
				({group, verb}) => `${group}/${verb}`,
			),
		).toEqual(["build/claim", "build/claims stale"]);
	});
});

/**
 * The ratchet over the live registry. Each group's baseline is `src/<group>/leaf-help-baseline.json`,
 * group-relative, so a migration child edits only its own group's file. An absent file is an empty
 * baseline.
 */
describe("every registered leaf verb holds the leaf help ratchet", () => {
	const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
	const groups: ReadonlyArray<DescribedNode> = registeredGroups;
	const groupNames = new Set(groups.map((group) => group.name));

	const baselineDirs = readdirSync(SRC_DIR, {withFileTypes: true})
		.filter(
			(entry) =>
				entry.isDirectory() && existsSync(`${SRC_DIR}${entry.name}/${LEAF_HELP_BASELINE_FILE}`),
		)
		.map((entry) => entry.name);

	const loaded = new Map<string, LeafHelpBaseline>(
		baselineDirs.map((dir) => [
			dir,
			JSON.parse(readFileSync(`${SRC_DIR}${dir}/${LEAF_HELP_BASELINE_FILE}`, "utf8")),
		]),
	);

	it("keeps every baseline in a registered group's own directory", () => {
		expect(baselineDirs.filter((dir) => !groupNames.has(dir))).toEqual([]);
	});

	it("reds nothing on the live walk", () => {
		expect(leafHelpRatchet(leafHelpWalk(groups), loaded).map(describeFinding)).toEqual([]);
	});
});
