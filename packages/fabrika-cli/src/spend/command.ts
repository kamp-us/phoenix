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
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {DEFAULT_SPEND_LEDGER_PATH} from "./ledger.ts";
import {runRead} from "./read-verb.ts";
import {runRollup} from "./rollup-verb.ts";

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
	Command.withShortDescription("One run's billed token spend, from its transcript."),
	Command.withDescription(
		"One run's billed token spend, reconstructed from its transcript (ADR 0112 §2). First stdout line is `spend\\t<billed>\\t<assistantTurns>`, then one `<field>\\t<value>` line each for input, cacheCreate, cacheRead, output, exCacheRead and model. --json emits the same eight fields as an object. Exits 7 (no transcript at that path — a proven absence), 11 (the transcript could not be read, or its absence could not be established — the spend is UNKNOWN, never zero), 12 (read in full and carrying zero billed assistant turns — a well-formed zero, not a measured spend). No threshold and no budget flag; the why is in .decisions/0112-token-measurement-no-quality-compromise-methodology.md. Example: fabrika spend read agent-3f9c1d2b.jsonl",
	),
);

const rollup = leafCommand(
	"rollup",
	{
		// `--ledger`, not `--spend-ledger`: inside `fabrika spend rollup` the group name is already
		// said.
		ledger: Flag.string("ledger").pipe(
			Flag.withDefault(DEFAULT_SPEND_LEDGER_PATH),
			Flag.withDescription(
				`the durable spend ledger to read, one JSON Lines row per recorded run (default: ${DEFAULT_SPEND_LEDGER_PATH})`,
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
	Command.withShortDescription("What fabrika's runs cost, from the durable spend ledger."),
	Command.withDescription(
		"What fabrika's runs cost, summed out of the durable spend ledger, spawning nothing and re-parsing no transcript. stdout is one record per line, first field naming the kind: billed, exCacheRead, assistantTurns, runs, measuredRuns, then skipped/skippedMalformed/skippedNewerVersion/undatedRows, then each breakdown's `day`, `skill` and `stage-arm` lines — at most ten per breakdown, its biggest-billing rows first, each followed by a `dayMore`/`skillMore`/`stageArmMore` count of the rows the cap dropped, printed even at `0`. skippedMalformed counts rows lost to data damage; skippedNewerVersion counts rows this CLI is too old to read. --since/--until bound the window (inclusive; a bare YYYY-MM-DD widens to the whole UTC day), --json emits the same answer as an object. Exits 7 (no ledger there — nothing recorded yet), 11 (the ledger could not be read — the spend is UNKNOWN, never zero), 12 (read in full, no rows at all), 13 (rows exist but this window selects none). No threshold and no budget flag; the why is in .decisions/0112-token-measurement-no-quality-compromise-methodology.md, the capped-breakdown shape in .decisions/0308-bounded-evidence-output-shape.md. Example: fabrika spend rollup --since 2026-08-01",
	),
);

export const spendCommand = Command.make("spend").pipe(
	Command.withSubcommands([read, rollup]),
	Command.withShortDescription("Read what fabrika's runs cost, in tokens."),
	Command.withDescription(
		"Read what fabrika's runs cost, in tokens — one run from its transcript, or all of them from the durable ledger",
	),
);
