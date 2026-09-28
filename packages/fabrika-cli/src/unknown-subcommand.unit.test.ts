import {NodeServices} from "@effect/platform-node";
import {Cause, Effect, Exit, Layer, Option} from "effect";
import {CliError, Command} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {describe, expect, it} from "vitest";
import {registeredGroups} from "./registry.ts";
import {fabrikaCommand} from "./root-command.ts";
import {type CommandNode, findUnknownSubcommand, refusal} from "./unknown-subcommand.ts";

const node = (
	name: string,
	subs: ReadonlyArray<CommandNode> = [],
	extra: {alias?: string; unlisted?: boolean} = {},
): CommandNode => ({
	name,
	alias: extra.alias,
	unlisted: extra.unlisted ?? false,
	subcommands: subs.length === 0 ? [] : [{commands: subs}],
});

describe("findUnknownSubcommand", () => {
	const leaf = node("leaf");
	const group = node("group", [
		node("verb", [], {alias: "v"}),
		node("secret", [], {unlisted: true}),
	]);
	const root = node("root", [group, leaf]);

	it("resolves an alias the parser would resolve", () => {
		expect(findUnknownSubcommand(root, ["group", "v"])).toBeUndefined();
	});

	it("resolves a unlisted subcommand by exact name, as the parser does", () => {
		expect(findUnknownSubcommand(root, ["group", "secret"])).toBeUndefined();
	});

	it("refuses an unknown token one level down, naming the group's path", () => {
		expect(findUnknownSubcommand(root, ["group", "nope"])).toEqual({
			token: "nope",
			path: ["root", "group"],
			known: ["verb"],
		});
	});

	it("withholds unlisted subcommands from what it offers, so a typo cannot reveal one", () => {
		expect(findUnknownSubcommand(root, ["group", "nope"])?.known).not.toContain("secret");
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

	it("finds groups at all — fail closed on zero scope", () => {
		expect(registeredGroups.length).toBeGreaterThan(0);
	});

	// The token used to be `triage`, the name the defect was reported against; registering that group
	// turned this fixture green for the wrong reason, so it moved to a name no slice will ever claim.
	it("refuses an unregistered group", () => {
		expect(findUnknownSubcommand(fabrikaCommand, ["nosuchgroup", "--help"])).toEqual({
			token: "nosuchgroup",
			path: ["fabrika"],
			known: registeredGroups.map((group) => group.name),
		});
	});

	it.each([
		["an unknown group", ["nosuchgroup"], "nosuchgroup", ["fabrika"]],
		["an unknown group probed with -h", ["nosuchgroup", "-h"], "nosuchgroup", ["fabrika"]],
		["an unknown verb in a known group", ["adr", "bogus"], "bogus", ["fabrika", "adr"]],
		["an unknown verb probed with --help", ["adr", "bogus", "--help"], "bogus", ["fabrika", "adr"]],
		[
			"a multi-token invalid tail probed with --help",
			["adr", "bogus", "deeper", "--help"],
			"bogus",
			["fabrika", "adr"],
		],
	])("refuses %s at its first invalid token", (_label, argv, token, path) => {
		const unknown = findUnknownSubcommand(fabrikaCommand, argv);
		expect(unknown?.token).toBe(token);
		expect(unknown?.path).toEqual(path);
	});

	it.each([
		["the root index", ["--help"]],
		["a group's verbs", ["adr", "--help"]],
		["a verb's flags", ["adr", "next", "--help"]],
		["a verb's flags behind another flag", ["adr", "next", "--dir", ".decisions", "--help"]],
	])("leaves the discovery path for %s unrefused", (_label, argv) => {
		expect(findUnknownSubcommand(fabrikaCommand, argv)).toBeUndefined();
	});
});

/**
 * A guard leaf registered under the wrong name reaches CI only as an unknown-subcommand refusal.
 * `findUnknownSubcommand` alone would pass a path whose guard were itself a leaf, so the walk also
 * requires the named leaf to exist and carry no subcommands.
 */
describe("each guard leaf is registered under its name", () => {
	const nodeAt = (path: ReadonlyArray<string>): CommandNode | undefined =>
		path.reduce<CommandNode | undefined>(
			(current, name) =>
				current?.subcommands
					.flatMap((group) => group.commands)
					.find((child) => child.name === name),
			fabrikaCommand,
		);

	it.each([
		["homing-guard", "check"],
		["pitch-guard", "check"],
		["roadmap-guard", "check"],
		["unresolved-threads-guard", "check"],
		["path-filter-guard", "check"],
		["change-detect-guard", "check"],
		["codeowners-cp", "check"],
		["decisions-index", "validate"],
		["design-token-guard", "check"],
		["design-inventory", "check"],
		["design-inventory", "generate"],
		["i18n-guard", "check"],
		["no-gh", "check"],
	])("resolves `fabrika guard %s %s` to a leaf", (guard, leaf) => {
		expect(findUnknownSubcommand(fabrikaCommand, ["guard", guard, leaf, "--help"])).toBeUndefined();
		const node = nodeAt(["guard", guard, leaf]);
		expect(node?.subcommands.flatMap((group) => group.commands)).toEqual([]);
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

	it("finds router nodes at all — fail closed on zero scope", () => {
		expect(paths.length).toBeGreaterThan(0);
	});

	it.each(
		paths.map((path) => [path.join(" ") || "(root)", path] as const),
	)("refuses at `fabrika %s`", async (_label, path) => {
		const exit = await Effect.runPromiseExit(
			Command.runWith(fabrikaCommand, {version: "test"})([...path, "__no_such_token__"]).pipe(
				Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
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
