/**
 * The `token-spend` tool — `pipeline-cli token-spend <transcript>`.
 *
 * The offline per-stage token-spend reporter for issue #1382 (epic #1356). Given a
 * pipeline-stage sub-agent's transcript (`agent-<id>.jsonl`), it reconstructs the billed
 * token spend from the per-message `usage` components (the pure `reconstructSpend` core)
 * and prints the `formatSessionCost` headline over the four-component breakdown — the
 * one-command replacement for the hand-run `jq` documented in
 * `.patterns/token-economics-measurement.md` §2.
 *
 * Thin IO shell over a pure core (the `leak-guard` / `ci-required` idiom): read the file,
 * run the core, print. An unreadable/missing transcript fails loudly with a clear stderr
 * note + a non-zero exit (this is an explicit, named report target, not a best-effort
 * scan — a bad path is an error, not a silent empty report).
 */
import {readFileSync} from "node:fs";
import {Console, Data, Effect} from "effect";
import {Argument, Command} from "effect/unstable/cli";
import {formatStageSpend, reconstructSpend} from "./token-spend.ts";

// A named transcript path that could not be read — a hard error (exit 1), not a skip.
class TranscriptUnreadable extends Data.TaggedError("TranscriptUnreadable")<{
	readonly path: string;
}> {}

const transcriptArg = Argument.string("transcript").pipe(
	Argument.withDescription(
		"path to a stage sub-agent transcript (`<session>/subagents/agent-<id>.jsonl`)",
	),
);

export const tokenSpendCommand = Command.make(
	"token-spend",
	{transcript: transcriptArg},
	Effect.fn(function* ({transcript}) {
		const run = Effect.gen(function* () {
			const text = yield* Effect.try({
				try: () => readFileSync(transcript, "utf8"),
				catch: () => new TranscriptUnreadable({path: transcript}),
			});
			const spend = reconstructSpend(text);
			if (spend.assistantTurns === 0) {
				yield* Console.error(
					`token-spend: no billed assistant messages found in ${transcript} — ` +
						"is this a stage sub-agent transcript (agent-<id>.jsonl)? Reporting zeros.",
				);
			}
			yield* Console.log(formatStageSpend(spend));
		});
		yield* run.pipe(
			Effect.catchTag("TranscriptUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`token-spend: cannot read transcript ${e.path}`);
					return yield* Effect.sync(() => process.exit(1));
				}),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Reconstruct a pipeline stage's billed token spend from its sub-agent transcript (#1382)",
	),
);
