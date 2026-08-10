import {describe, expect, it} from "vitest";
import {registeredGroups} from "./registry.ts";
import {SHORT_DESCRIPTION_BUDGET, shortDescriptionDefects} from "./short-description.ts";
import type {CommandNode} from "./unknown-subcommand.ts";

describe("shortDescriptionDefects", () => {
	it("passes a one-sentence line inside the budget", () => {
		expect(shortDescriptionDefects("Rank the live ADRs this one may contradict.")).toEqual([]);
	});

	it("names an absent line rather than passing it", () => {
		expect(shortDescriptionDefects(undefined)).toHaveLength(1);
		expect(shortDescriptionDefects("   ")).toHaveLength(1);
	});

	it("reds on the contract material the verb's own --help owns", () => {
		expect(shortDescriptionDefects("Do a thing. Exits 3 when absent.").length).toBeGreaterThan(0);
		expect(shortDescriptionDefects("Stdout is one line per code.").length).toBeGreaterThan(0);
		expect(
			shortDescriptionDefects("Do a thing, Example: fabrika adr next.").length,
		).toBeGreaterThan(0);
	});

	it("reds on a line over the budget", () => {
		expect(shortDescriptionDefects(`${"x".repeat(SHORT_DESCRIPTION_BUDGET)}.`)).toEqual([
			`${SHORT_DESCRIPTION_BUDGET + 1} characters, over the ${SHORT_DESCRIPTION_BUDGET}-character budget`,
		]);
	});
});

/**
 * The coverage guard: a leaf shipped with no short description silently falls back to its full
 * contract paragraph in the group's `SUBCOMMANDS` list, which is the defect back again on the next
 * verb (#5208). Reds instead.
 *
 * It reads `shortDescription` off the `Command`'s runtime shape — the same deliberately-confined
 * idiom `./excess-operand.unit.test.ts` uses, a plain widening assignment and never a cast, so a
 * rename upstream reds here at build time rather than leaving the assertion vacuous.
 */
describe("every registered leaf verb carries a short list-row description", () => {
	interface DescribedCommand extends Omit<CommandNode, "subcommands"> {
		readonly description?: string | undefined;
		readonly shortDescription?: string | undefined;
		readonly subcommands: ReadonlyArray<{readonly commands: ReadonlyArray<DescribedCommand>}>;
	}

	const leaves = (
		node: DescribedCommand,
		prefix: ReadonlyArray<string>,
	): ReadonlyArray<readonly [string, DescribedCommand]> => {
		const path = [...prefix, node.name];
		const children = node.subcommands.flatMap((group) => group.commands);
		if (children.length === 0) return [[path.join(" "), node]];
		return children.flatMap((child) => leaves(child, path));
	};

	const groups: ReadonlyArray<DescribedCommand> = registeredGroups;
	const verbs = groups.flatMap((group) => leaves(group, ["fabrika"]));

	it("finds leaf verbs at all — fail closed on zero scope (ADR 0092)", () => {
		expect(verbs.length).toBeGreaterThan(0);
	});

	it.each(
		verbs.map(([label, verb]) => [label, verb] as const),
	)("`%s` lists as one scannable line", (_label, verb) => {
		expect(shortDescriptionDefects(verb.shortDescription)).toEqual([]);
	});

	it.each(
		verbs.map(([label, verb]) => [label, verb] as const),
	)("`%s` keeps its full contract in the long description", (_label, verb) => {
		expect(verb.description ?? "").not.toBe("");
		expect((verb.description ?? "").length).toBeGreaterThan((verb.shortDescription ?? "").length);
	});
});
