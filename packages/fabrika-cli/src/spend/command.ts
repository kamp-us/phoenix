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
import {DEFAULT_SPEND_LEDGER_PATH} from "./ledger.ts";
import {runRead} from "./read-verb.ts";
import {runRollup} from "./rollup-verb.ts";

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
		"One run's billed token spend, reconstructed from its transcript (ADR 0112 §2). First stdout line is `spend\\t<billed>\\t<assistantTurns>`, then one `<field>\\t<value>` line each for input, cacheCreate, cacheRead, output, exCacheRead and model — the cache-read share stays its own number because it is the context-bloat signal. --json emits the same eight fields as an object. Exits 7 (no transcript at that path — a proven absence), 11 (the transcript could not be read, or its absence could not be established — the spend is UNKNOWN, never zero), 12 (read in full and carrying zero billed assistant turns — a well-formed zero, not a measured spend). No threshold, no budget flag, and no exit code that varies with a spend magnitude. Example: fabrika spend read agent-3f9c1d2b.jsonl",
	),
);

const rollup = leafCommand(
	"rollup",
	{
		// `--ledger`, not `--spend-ledger`: inside `fabrika spend rollup` the group name is already
		// said, and the description names the writer's flag so the pairing stays findable.
		ledger: Flag.string("ledger").pipe(
			Flag.withDefault(DEFAULT_SPEND_LEDGER_PATH),
			Flag.withDescription(
				`the durable spend ledger to read — the file \`fabrika eval run --spend-ledger\` appends to (default: ${DEFAULT_SPEND_LEDGER_PATH})`,
			),
		),
		since: Flag.string("since").pipe(
			Flag.optional,
			Flag.withDescription(
				"inclusive lower bound — an ISO-8601 instant, or a bare YYYY-MM-DD meaning that UTC day's first millisecond",
			),
		),
		until: Flag.string("until").pipe(
			Flag.optional,
			Flag.withDescription(
				"inclusive upper bound — an ISO-8601 instant, or a bare YYYY-MM-DD meaning through that whole UTC day",
			),
		),
		json: Flag.boolean("json").pipe(
			Flag.withDescription("emit the same answer as JSON on stdout instead of the line grammar"),
		),
	},
	Effect.fn(function* ({ledger, since, until, json}) {
		yield* emit(
			yield* runRollup({
				ledger,
				since: since._tag === "Some" ? since.value : null,
				until: until._tag === "Some" ? until.value : null,
				json,
			}),
		);
	}),
).pipe(
	Command.withDescription(
		"What fabrika's runs cost, summed out of the durable spend ledger — the one command that answers it from persisted data, spawning nothing and re-parsing no transcript. stdout is one record per line, first field naming the kind: billed, exCacheRead, assistantTurns, runs, measuredRuns, then skipped/skippedMalformed/skippedNewerVersion/undatedRows, then one `day`, `skill` and `stage-arm` line per bucket. The skipped counts ride on the answer so a partially-unreadable ledger can never present as a quietly smaller total, and they are split because a malformed line is data loss while a newer-version line means upgrade this CLI. --since/--until bound the window (inclusive; a bare YYYY-MM-DD widens to the whole UTC day), --json emits the same answer as an object. Exits 7 (no ledger there — nothing recorded yet), 11 (the ledger could not be read — the spend is UNKNOWN, never zero), 12 (read in full, no rows at all), 13 (rows exist but this window selects none). No threshold, no budget flag, and no exit code that varies with a spend magnitude. Example: fabrika spend rollup --since 2026-08-01",
	),
);

export const spendCommand = Command.make("spend").pipe(
	Command.withSubcommands([read, rollup]),
	Command.withDescription(
		"Read what fabrika's runs cost, in tokens — one run from its transcript, or all of them from the durable ledger",
	),
);
