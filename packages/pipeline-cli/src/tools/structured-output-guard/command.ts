/**
 * The `structured-output-guard` tool — `pipeline-cli structured-output-guard <prompt|decide>`.
 *
 * The StructuredOutput conformance slice for issue #742 (epic #737), moved into the
 * pipeline-cli registry (epic #994, Phase 2 / #1002). Two verbs, both reading their
 * JSON input from stdin (the spawn-prompt builder and the validation path are both
 * shell-callable orchestrator steps):
 *
 *   - `prompt`  in:  {schema, example?}                 out (stdout): the spawn-prompt
 *               section — the exact field list + filled example to inject up front so a
 *               subagent's final StructuredOutput call conforms first-try. Always exit 0.
 *   - `decide`  in:  {payload, schema, retryCount?, cap?, example?}  out: a Decision JSON
 *               on stdout AND a process exit code the validation path branches on:
 *                 0 → accept (payload conforms)
 *                 1 → fail   (retry budget exhausted; the rich message is in the JSON)
 *                 2 → retry  (budget remains; re-prompt the agent with `.message`)
 *
 * The exit-code split lets a thin shell wrapper route without parsing. The
 * stdin-JSON-arg / stdout-Decision-JSON / exit-0/1/2 contract is preserved byte-for-byte
 * from the former package's `bin.ts`; only the `Command.run`/`Effect.provide`/`runMain`
 * wiring is dropped — the shared `pipeline-cli` bin owns the run boundary (`NodeServices`).
 */
import {readFileSync} from "node:fs";
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
	// biome-ignore lint/plugin: best-effort read — an unreadable stdin is absorbed into "" (no input), never the E channel; a total helper, not Effect-cosplay.
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

export const structuredOutputGuardCommand = Command.make("structured-output-guard").pipe(
	Command.withSubcommands([promptCmd, decideCmd]),
	Command.withDescription(
		"Make a subagent's final StructuredOutput call conform first-try and self-correct in one retry (issue #742)",
	),
);
