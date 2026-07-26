/**
 * The `commands` tool — `pipeline-cli commands <compact|check>` (#3316).
 *
 * The rot-proof tool-discovery surface, mirroring `decisions-index` (ADR 0126/0129,
 * "discovery is the CLAUDE.md contract"):
 *   pipeline-cli commands compact   # emit one line per registered tool: name · description
 *   pipeline-cli commands check     # PR gate: exit non-zero if any registered tool has no description
 *
 * `compact` is the on-demand discovery map an agent reads to know what exists before
 * hand-rolling `gh`/`jq`/`git` glue around an already-tested tool. `check` is the
 * fail-closed backstop: a newly-registered tool can't silently ship without a one-line
 * purpose (AC #4), and a zero-length registry reds (fail-closed on zero scope, ADR 0092).
 *
 * The index needs every tool's `description`, so this is the one tool that resolves the
 * whole registry — the lazy rows have to be loaded to be described (#4008). A row that
 * won't load is omitted from `compact` with a note on stderr (a discovery surface that
 * dies on one broken sibling is worse than a short one) and reds `check`, which is the
 * gate and so stays fail-closed.
 *
 * Exit-code contract (shared with the other gate tools): 0 = clean; a gate fail prints its
 * reason on stderr and exits non-zero *without* a stack trace, caught inside the handler so
 * the contract survives the shared `pipeline-cli` bin (which provides no per-tool catch).
 */
import {Console, Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {registeredTools} from "../../registry.ts";
import {type LoadedRegistry, loadRegistry} from "../../tool-registration.ts";
import {renderCompact, undocumentedTools} from "./commands.ts";

const loadAll = Effect.promise<LoadedRegistry>(() => loadRegistry(registeredTools));

const GATE_FAIL_EXIT_CODE = 1;

const compact = Command.make(
	"compact",
	{},
	Effect.fn(function* () {
		const {tools, failures} = yield* loadAll;
		for (const failure of failures) {
			yield* Console.error(`commands: omitting \`${failure.name}\` — ${failure.error.message}`);
		}
		yield* Console.log(renderCompact(tools));
	}),
).pipe(
	Command.withDescription(
		"Emit the compact tool index (one line per registered tool: name · description) to stdout",
	),
);

const check = Command.make(
	"check",
	{},
	Effect.fn(function* () {
		const {tools, failures} = yield* loadAll;
		// Fail-closed on zero scope: an empty registry is a wiring/load fault, not a pass (ADR 0092).
		if (registeredTools.length === 0) {
			yield* fail("no registered tools in scope — refusing to pass on an empty registry");
			return;
		}
		if (failures.length > 0) {
			yield* fail(
				`registration(s) that failed to load: ${failures.map((f) => f.name).join(", ")}\n${failures
					.map((f) => f.error.message)
					.join("\n")}`,
			);
			return;
		}
		const missing = undocumentedTools(tools);
		if (missing.length > 0) {
			yield* fail(
				`registered tool(s) missing a one-line description (add Command.withDescription): ${missing.join(", ")}`,
			);
			return;
		}
		yield* Console.log(`commands: ${tools.length} registered tools, all documented`);
	}),
).pipe(
	Command.withDescription(
		"PR gate: exit non-zero if any registered tool ships without a one-line description (fail-closed)",
	),
);

const fail = (reason: string): Effect.Effect<void> =>
	Effect.sync(() => {
		process.stderr.write(`commands: ${reason}\n`);
		process.exit(GATE_FAIL_EXIT_CODE);
	});

export const commandsCommand = Command.make("commands").pipe(
	Command.withSubcommands([compact, check]),
	Command.withDescription(
		"Rot-proof tool discovery: list every registered pipeline-cli tool + its one-line purpose (#3316)",
	),
);
