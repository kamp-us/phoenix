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
 * The `registeredTools` import closes a registry ⇄ tool cycle (this tool is itself in the
 * registry), but it is read **only inside the handler closures** — never at module-eval
 * time — so the ESM live binding is fully initialized by the time a handler runs. Do not
 * hoist `registeredTools` to a top-level reference here, or the cycle becomes a TDZ read.
 *
 * Exit-code contract (shared with the other gate tools): 0 = clean; a gate fail prints its
 * reason on stderr and exits non-zero *without* a stack trace, caught inside the handler so
 * the contract survives the shared `pipeline-cli` bin (which provides no per-tool catch).
 */
import {Console, Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {registeredTools} from "../../registry.ts";
import {renderCompact, undocumentedTools} from "./commands.ts";

const GATE_FAIL_EXIT_CODE = 1;

const compact = Command.make(
	"compact",
	{},
	Effect.fn(function* () {
		yield* Console.log(renderCompact(registeredTools));
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
		// Fail-closed on zero scope: an empty registry is a wiring/load fault, not a pass (ADR 0092).
		if (registeredTools.length === 0) {
			yield* fail("no registered tools in scope — refusing to pass on an empty registry");
			return;
		}
		const missing = undocumentedTools(registeredTools);
		if (missing.length > 0) {
			yield* fail(
				`registered tool(s) missing a one-line description (add Command.withDescription): ${missing.join(", ")}`,
			);
			return;
		}
		yield* Console.log(`commands: ${registeredTools.length} registered tools, all documented`);
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
