import {NodeServices} from "@effect/platform-node";
import {Cause, Effect, Exit, Option} from "effect";
import {CliError, Command} from "effect/unstable/cli";
import {describe, expect, it} from "vitest";
import {registeredGroups} from "./registry.ts";
import {fabrikaCommand} from "./root-command.ts";
import {type CommandNode, findUnknownSubcommand, refusal} from "./unknown-subcommand.ts";

const node = (
	name: string,
	subs: ReadonlyArray<CommandNode> = [],
	extra: {alias?: string; hidden?: boolean} = {},
): CommandNode => ({
	name,
	alias: extra.alias,
	hidden: extra.hidden ?? false,
	subcommands: subs.length === 0 ? [] : [{commands: subs}],
});

describe("findUnknownSubcommand", () => {
	const leaf = node("leaf");
	const group = node("group", [node("verb", [], {alias: "v"}), node("secret", [], {hidden: true})]);
	const root = node("root", [group, leaf]);

	it("resolves a known path to no refusal", () => {
		expect(findUnknownSubcommand(root, ["group", "verb"])).toBeUndefined();
	});

	it("resolves an alias the parser would resolve", () => {
		expect(findUnknownSubcommand(root, ["group", "v"])).toBeUndefined();
	});

	it("resolves a hidden subcommand by exact name, as the parser does", () => {
		expect(findUnknownSubcommand(root, ["group", "secret"])).toBeUndefined();
	});

	it("refuses an unknown token at the root, naming the path and what root offers", () => {
		expect(findUnknownSubcommand(root, ["nope"])).toEqual({
			token: "nope",
			path: ["root"],
			known: ["group", "leaf"],
		});
	});

	it("refuses an unknown token one level down, naming the group's path", () => {
		expect(findUnknownSubcommand(root, ["group", "nope"])).toEqual({
			token: "nope",
			path: ["root", "group"],
			known: ["verb"],
		});
	});

	it("withholds hidden subcommands from what it offers, so a typo cannot reveal one", () => {
		expect(findUnknownSubcommand(root, ["group", "nope"])?.known).not.toContain("secret");
	});

	it("reports the FIRST unknown token, not the last, however long the invalid tail", () => {
		expect(findUnknownSubcommand(root, ["group", "nope", "deeper", "deepest"])?.token).toBe("nope");
	});

	it("stops at a leaf — its tokens are its own arguments, not subcommands", () => {
		expect(findUnknownSubcommand(root, ["leaf", "whatever"])).toBeUndefined();
	});

	it("stops at a flag — a later bare token may be that flag's value", () => {
		expect(findUnknownSubcommand(root, ["--log-level", "debug"])).toBeUndefined();
	});

	it("treats empty argv as resolved (the bare-root help case)", () => {
		expect(findUnknownSubcommand(root, [])).toBeUndefined();
	});

	it("refuses before a trailing help flag, whichever spelling", () => {
		for (const help of ["--help", "-h"]) {
			expect(findUnknownSubcommand(root, ["nope", help])?.token).toBe("nope");
		}
	});
});

describe("refusal", () => {
	it("keeps the runner's own wording and appends what the node accepts", () => {
		expect(refusal({token: "bogus", path: ["fabrika", "adr"], known: ["next", "new"]})).toBe(
			'fabrika: Unknown subcommand "bogus" for "fabrika adr" — known subcommands: next, new',
		);
	});

	it("says so rather than trailing off when a node offers nothing", () => {
		expect(refusal({token: "bogus", path: ["fabrika"], known: []})).toContain(
			"known subcommands: (none)",
		);
	});
});

describe("against the real fabrika command tree", () => {
	it("resolves every registered group", () => {
		for (const group of registeredGroups) {
			expect(findUnknownSubcommand(fabrikaCommand, [group.name])).toBeUndefined();
		}
	});

	it("finds groups at all — fail closed on zero scope (ADR 0092)", () => {
		expect(registeredGroups.length).toBeGreaterThan(0);
	});

	// The token used to be `triage`, which #4822 was reported against; registering that group turned
	// this fixture green for the wrong reason, so it moved to a name no slice will ever claim.
	it("refuses an unregistered group", () => {
		expect(findUnknownSubcommand(fabrikaCommand, ["nosuchgroup", "--help"])).toEqual({
			token: "nosuchgroup",
			path: ["fabrika"],
			known: registeredGroups.map((group) => group.name),
		});
	});

	it("refuses an unregistered verb inside a registered group", () => {
		expect(
			findUnknownSubcommand(fabrikaCommand, ["adr", "bogus", "deeper", "--help"])?.path,
		).toEqual(["fabrika", "adr"]);
	});
});

/**
 * Closes the one divergence `findUnknownSubcommand` documents: if a future group ever declared both
 * subcommands and positional arguments, the parser would read an unknown token as an argument while
 * the guard refused it. This reds there instead.
 *
 * `Command.runWith` drives a command over an explicit argument array (`effect/unstable/cli/Command.ts`,
 * `runWith`'s "Test help display" example) and bypasses `run.ts` — so the runner answers here, never
 * the guard.
 */
describe("the parser refuses an unknown token at every node that carries subcommands", () => {
	const routerPaths = (
		command: CommandNode,
		prefix: ReadonlyArray<string> = [],
	): ReadonlyArray<ReadonlyArray<string>> => {
		const children = command.subcommands.flatMap((group) => group.commands);
		if (children.length === 0) return [];
		return [prefix, ...children.flatMap((child) => routerPaths(child, [...prefix, child.name]))];
	};

	const paths = routerPaths(fabrikaCommand);

	it("finds router nodes at all — fail closed on zero scope (ADR 0092)", () => {
		expect(paths.length).toBeGreaterThan(0);
	});

	it.each(
		paths.map((path) => [path.join(" ") || "(root)", path] as const),
	)("refuses at `fabrika %s`", async (_label, path) => {
		const exit = await Effect.runPromiseExit(
			Command.runWith(fabrikaCommand, {version: "test"})([...path, "__no_such_token__"]).pipe(
				Effect.provide(NodeServices.layer),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const failure = Exit.isFailure(exit)
			? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
			: undefined;
		expect(
			CliError.isCliError(failure) &&
				failure._tag === "ShowHelp" &&
				failure.errors.some((error) => error._tag === "UnknownSubcommand"),
		).toBe(true);
	});
});
