import {describe, expect, it} from "vitest";
import {EXCESS_OPERAND_NAME, excessRefusal} from "./excess-operand.ts";
import {registeredGroups} from "./registry.ts";
import type {CommandNode} from "./unknown-subcommand.ts";

describe("excessRefusal", () => {
	it("names the token and the path it was rejected at", () => {
		expect(excessRefusal(["fabrika", "adr", "next"], ["bogus"])).toBe(
			'fabrika: unexpected operand "bogus" for "fabrika adr next" — the verb declares no argument to bind it to',
		);
	});

	it("names every token when more than one was passed", () => {
		expect(excessRefusal(["fabrika", "adr", "next"], ["a", "b"])).toContain(
			'unexpected operands "a", "b"',
		);
	});
});

/**
 * The coverage guard: a leaf declared with a bare `Command.make` is silently unguarded, which is this
 * defect back again on the next verb. Reds instead.
 *
 * It reads the leaf's declared arguments off the `Command`'s runtime config — a shape the public
 * `Command` interface does not expose, deliberately confined to this test. A rename upstream reds
 * here at build time rather than disarming the guard at run time.
 */
describe("every registered leaf verb declares the excess-operand catch-all", () => {
	/** A `Param` as this test reads it: a combinator chain (`Variadic`, `Optional`, …) over a `Single`. */
	interface ParamNode {
		readonly _tag?: string;
		readonly name?: string;
		readonly param?: ParamNode;
	}

	interface ConfiguredCommand extends Omit<CommandNode, "subcommands"> {
		readonly config?: {readonly arguments?: ReadonlyArray<ParamNode>};
		readonly subcommands: ReadonlyArray<{readonly commands: ReadonlyArray<ConfiguredCommand>}>;
	}

	const declaredName = (param: ParamNode | undefined): string | undefined => {
		let node = param;
		while (node !== undefined && node._tag !== "Single") node = node.param;
		return node?.name;
	};

	const leaves = (
		node: ConfiguredCommand,
		prefix: ReadonlyArray<string>,
	): ReadonlyArray<readonly [string, ConfiguredCommand]> => {
		const path = [...prefix, node.name];
		const children = node.subcommands.flatMap((group) => group.commands);
		if (children.length === 0) return [[path.join(" "), node]];
		return children.flatMap((child) => leaves(child, path));
	};

	const groups: ReadonlyArray<ConfiguredCommand> = registeredGroups;
	const verbs = groups.flatMap((group) => leaves(group, ["fabrika"]));

	it("finds leaf verbs at all — fail closed on zero scope (ADR 0092)", () => {
		expect(verbs.length).toBeGreaterThan(0);
	});

	it.each(
		verbs.map(([label, verb]) => [label, verb] as const),
	)("`%s` binds its trailing operands", (_label, verb) => {
		const declared = verb.config?.arguments;
		expect(declared, "the Command runtime config no longer exposes `arguments`").toBeDefined();
		expect(declaredName(declared?.at(-1))).toBe(EXCESS_OPERAND_NAME);
	});
});
