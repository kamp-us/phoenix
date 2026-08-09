/**
 * The `spend` verb group — `fabrika spend <verb>`.
 *
 * The adapter and nothing else: it declares the argument and the flag (`--help` is the interface, so
 * each carries a one-line description), runs the pure verb, and emits its outcome. Every decision
 * lives in `read-verb.ts` beside it, which is what makes each refusal testable without spawning a
 * process.
 */
import {Effect} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import type {VerbOutcome} from "../verb.ts";
import {runRead} from "./read-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const read = leafCommand(
	"read",
	{
		transcript: Argument.string("transcript").pipe(
			Argument.withDescription("path to the run's JSONL transcript"),
		),
		json: Flag.boolean("json").pipe(
			Flag.withDescription("emit the answer as JSON on stdout instead of the line grammar"),
		),
	},
	Effect.fn(function* ({transcript, json}) {
		yield* emit(yield* runRead({transcript, json}));
	}),
).pipe(
	Command.withDescription(
		"One run's billed token spend, reconstructed from its transcript (ADR 0112 §2). First stdout line is `spend\\t<billed>\\t<assistantTurns>`, then one `<field>\\t<value>` line each for input, cacheCreate, cacheRead, output, exCacheRead and model — the cache-read share stays its own number because it is the context-bloat signal. --json emits the same eight fields as an object. Exits 3 (no transcript at that path — a proven absence), 4 (the transcript could not be read, or its absence could not be established — the spend is UNKNOWN, never zero), 5 (read in full and carrying zero billed assistant turns — a well-formed zero, not a measured spend). No threshold, no budget flag, and no exit code that varies with a spend magnitude. Example: fabrika spend read agent-3f9c1d2b.jsonl",
	),
);

export const spendCommand = Command.make("spend").pipe(
	Command.withSubcommands([read]),
	Command.withDescription("Read what one fabrika run cost, in tokens, from its transcript"),
);
