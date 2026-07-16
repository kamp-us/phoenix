/**
 * Verb-wiring: the root `anka-ops` command exposes exactly the verb groups the `VERB_GROUPS`
 * registry advertises. The load-bearing assertion is that the registry and the actual
 * `withSubcommands` tree can't drift — when a child (B `flag` / C `report`) folds in a group it
 * must touch both, and this test reds if it touches only one. No IO: the command tree is a
 * pure value.
 */
import {assert, describe, it} from "@effect/vitest";
import {ankaOps, VERB_GROUPS} from "./cli.ts";

/** Flatten the wired subcommand names off the (group, commands) tree. */
const wiredSubcommandNames = (): ReadonlyArray<string> =>
	ankaOps.subcommands.flatMap((entry) => entry.commands.map((command) => command.name)).sort();

describe("ankaOps command tree", () => {
	it("is rooted at `anka-ops`", () => {
		assert.strictEqual(ankaOps.name, "anka-ops");
	});

	it("wires the `auth` verb group (the skeleton's only shipped group)", () => {
		assert.deepStrictEqual(wiredSubcommandNames(), ["auth"]);
	});

	it("the registry advertises exactly the wired verb groups (no drift)", () => {
		const registered = VERB_GROUPS.map((group) => group.name).sort();
		assert.deepStrictEqual(registered, wiredSubcommandNames());
	});

	it("every registry descriptor carries a non-empty summary", () => {
		for (const group of VERB_GROUPS) {
			assert.isAbove(group.summary.trim().length, 0);
		}
	});
});
