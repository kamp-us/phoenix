/**
 * The pipeline-cli router wiring — the real bin body, behind `bin.ts`'s bootstrap.
 *
 * It is loaded via a **dynamic** `import()` from `bin.ts` on purpose (#1798): deferring
 * the link until inside a `try` is what makes an unlinked-`catalog:`-dep
 * `ERR_MODULE_NOT_FOUND` catchable, so the bin can print a remediation instead of a raw
 * stack. Keeping the wiring here (not in `bin.ts`) keeps that boundary clean.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/decisions-index` /
 * `@kampus/epic-ledger`): `effect/unstable/cli` for the typed subcommands, the Node
 * platform over `NodeServices.layer`, run via `NodeRuntime.runMain`.
 *
 * The subcommand set is resolved **for this invocation only** (see `tool-registration.ts`):
 * selecting a tool loads that tool; only a listing (`--help`, no token) loads them all, and
 * even there a registration that won't resolve is reported and skipped, not fatal.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Effect, Result} from "effect";
import {CliError, Command} from "effect/unstable/cli";
import {BAD_INVOCATION_EXIT_CODE} from "./exit-codes.ts";
import {registeredTools} from "./registry.ts";
import {dispatch} from "./router.ts";
import {
	loadRegistration,
	loadRegistry,
	type RegisteredTool,
	ToolLoadError,
} from "./tool-registration.ts";
import {VERSION} from "./version.ts";

const argv = process.argv.slice(2);
const selector = argv[0];

const exitWith = (message: string): never => {
	console.error(message);
	process.exit(1);
};

/**
 * A leading `-` (or nothing at all) is a top-level flag, not a selector: `--help` lists
 * every tool and `--version` needs no tool, so both fall to the load-everything branch.
 */
const resolveSubcommands = async (): Promise<ReadonlyArray<RegisteredTool>> => {
	if (selector === undefined || selector.startsWith("-")) {
		const {tools, failures} = await loadRegistry(registeredTools);
		for (const failure of failures) console.error(failure.error.message);
		return tools;
	}
	const selected = dispatch(registeredTools, argv);
	if (Result.isFailure(selected)) return exitWith(selected.failure.message);
	// biome-ignore lint/plugin: pre-runtime bootstrap — the tool graph is loaded to BUILD the CLI, so there is no Effect runtime yet to carry this in an `E` channel.
	try {
		return [await loadRegistration(selected.success.tool)];
	} catch (err) {
		// The attributable report is the whole point of the lazy registry; anything else
		// (notably an unlinked dep) belongs to `bin.ts`'s self-heal, so it propagates.
		if (err instanceof ToolLoadError) return exitWith(err.message);
		throw err;
	}
};

const cli = Command.make("pipeline-cli").pipe(
	Command.withSubcommands(await resolveSubcommands()),
	Command.withDescription("The pipeline tooling router — `pipeline-cli <tool> …` (epic #994)"),
);

cli.pipe(
	Command.run({version: VERSION}),
	// A parse failure is "the verb never ran", so it must not land on the exit code some verb uses
	// for a verdict. effect-cli fails with a `CliError` (after printing help) and `runMain` would
	// exit 1 — which `cp-cardinality decide` uses for `stop`. See `BAD_INVOCATION_EXIT_CODE` (#5072).
	Effect.catchIf(CliError.isCliError, () =>
		Effect.sync(() => process.exit(BAD_INVOCATION_EXIT_CODE)),
	),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
