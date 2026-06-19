/**
 * `structured-output-guard` CLI — the harness wiring of the pure core (issue #742).
 *
 * Two verbs, both reading their JSON input from stdin (the spawn-prompt builder and the
 * StructuredOutput validation path are both shell-callable steps in the orchestrator):
 *
 *   - `prompt`  in:  {schema, example?}                  out: the spawn-prompt section
 *               (stdout) — the exact field list + filled example to inject up front so a
 *               subagent's final StructuredOutput call conforms first-try.
 *
 *   - `decide`  in:  {payload, schema, retryCount, cap?, example?}  out: a Decision JSON
 *               on stdout AND a process exit code the validation path branches on:
 *                 0 → accept (payload conforms)
 *                 1 → fail   (retry budget exhausted; the rich message is in the JSON)
 *                 2 → retry  (budget remains; re-prompt the agent with `.message`)
 *
 * The exit-code split lets a thin shell wrapper in the harness route without parsing:
 * accept proceeds, retry re-prompts with the message, fail surfaces it and stops. The
 * full Decision (incl. the rich missing+present diff + message) is always on stdout.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/leak-guard`):
 * `effect/unstable/cli` for the subcommands, `@effect/platform-node` for stdin, run via
 * `NodeRuntime.runMain`.
 */
import {readFileSync} from "node:fs";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {
	type Decision,
	decide,
	type OutputSchema,
	renderSchemaSection,
} from "./structured-output-guard.ts";

const EXIT_ACCEPT = 0;
const EXIT_FAIL = 1;
const EXIT_RETRY = 2;

const readStdin = (): string => {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
};

interface PromptInput {
	readonly schema: OutputSchema;
	readonly example?: Record<string, unknown>;
}

interface DecideInput {
	readonly payload: Record<string, unknown>;
	readonly schema: OutputSchema;
	readonly retryCount?: number;
	readonly cap?: number;
	readonly example?: Record<string, unknown>;
}

const promptCmd = Command.make(
	"prompt",
	{},
	Effect.fn(function* () {
		const input = JSON.parse(readStdin()) as PromptInput;
		yield* Console.log(renderSchemaSection(input.schema, input.example));
	}),
).pipe(
	Command.withDescription(
		"Render the spawn-prompt schema section (schema+example on stdin) for a StructuredOutput subagent",
	),
);

const exitFor = (decision: Decision): number =>
	decision.kind === "accept" ? EXIT_ACCEPT : decision.kind === "fail" ? EXIT_FAIL : EXIT_RETRY;

const decideCmd = Command.make(
	"decide",
	{},
	Effect.fn(function* () {
		const input = JSON.parse(readStdin()) as DecideInput;
		const options: {cap?: number; example?: Record<string, unknown>} = {};
		if (input.cap !== undefined) options.cap = input.cap;
		if (input.example !== undefined) options.example = input.example;
		const decision = decide(input.payload, input.schema, input.retryCount ?? 0, options);
		yield* Console.log(JSON.stringify(decision, null, 2));
		return yield* Effect.sync(() => process.exit(exitFor(decision)));
	}),
).pipe(
	Command.withDescription(
		"Run the accept/retry/fail decision (payload+schema+retryCount on stdin); exit 0/1/2",
	),
);

const guard = Command.make("structured-output-guard").pipe(
	Command.withSubcommands([promptCmd, decideCmd]),
	Command.withDescription(
		"Make a subagent's final StructuredOutput call conform first-try and self-correct in one retry (issue #742)",
	),
);

guard.pipe(
	Command.run({version: "0.0.0"}),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
