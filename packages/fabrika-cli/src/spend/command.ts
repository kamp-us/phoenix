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
import {readStdin} from "../io/stdin.ts";
import {refuse} from "../verb.ts";
import {DEFAULT_SPEND_LEDGER_PATH} from "./ledger.ts";
import {runLedgerRead, runRead} from "./read-verb.ts";
import {runRecord} from "./record-verb.ts";
import {runRollup} from "./rollup-verb.ts";

const read = leafCommand(
	"read",
	{
		transcript: Argument.string("transcript").pipe(
			Argument.optional,
			Argument.withDescription("path to the run's JSONL transcript"),
		),
		ledger: Flag.string("ledger").pipe(
			Flag.optional,
			Flag.withDescription("read versioned usage records from this ledger; emits JSON"),
		),
		json: Flag.boolean("json").pipe(
			Flag.withDescription("emit the answer as JSON on stdout instead of the line grammar"),
		),
	},
	Effect.fn(function* ({transcript, ledger, json}) {
		if (transcript._tag === "Some" && ledger._tag === "None") {
			yield* emit(yield* runRead({transcript: transcript.value, json}));
		} else if (ledger._tag === "Some" && transcript._tag === "None") {
			yield* emit(yield* runLedgerRead(ledger.value));
		} else yield* emit(refuse(1, "spend read: supply either a transcript or --ledger"));
	}),
).pipe(
	Command.withShortDescription("Read attributed ledger records or a legacy transcript."),
	Command.withDescription(
		"Read either a positional legacy transcript or --ledger <path>, never both. Ledger mode always emits JSON {records, legacy, diagnostics}; diagnostics counts malformed, newerVersion, duplicates and conflicts. Records preserve model/provider, counters and participant/coverage notices. Reading records is not a completeness claim. Legacy transcript mode reconstructs the sum of four usage components per assistant message: first stdout line is `spend\\t<billed>\\t<assistantTurns>`, followed by input, cacheCreate, cacheRead, output, exCacheRead and model rows; --json emits those eight fields as an object. Exits 1 (ambiguous or missing input), 7 (input absent), 11 (input unreadable), 12 (legacy transcript has no billed turns). Example: fabrika spend read --ledger .fabrika/spend-ledger.jsonl --json",
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
		"What fabrika's runs cost, summed out of the durable spend ledger, spawning nothing and re-parsing no transcript. stdout is one record per line, first field naming the kind: billed, exCacheRead, assistantTurns, runs, measuredRuns, then skipped/skippedMalformed/skippedNewerVersion/undatedRows, then each breakdown's `day`, `skill` and `stage-arm` lines — at most ten per breakdown, its biggest-billing rows first, each followed by a `dayMore`/`skillMore`/`stageArmMore` count of the rows the cap dropped, printed even at `0`. skippedMalformed counts rows lost to data damage; skippedNewerVersion counts rows this CLI is too old to read. --since/--until bound the window (inclusive; a bare YYYY-MM-DD widens to the whole UTC day), --json emits the same answer as an object. Exits 7 (no ledger there — nothing recorded yet), 11 (the ledger could not be read — the spend is UNKNOWN, never zero), 12 (read in full, no rows at all), 13 (rows exist but this window selects none). No threshold and no budget flag: measuring what the runs cost must never become a way to fail one. The breakdowns are capped so an ever-growing ledger cannot print an ever-growing answer. Example: fabrika spend rollup --since 2026-08-01",
	),
);

const record = leafCommand(
	"record",
	{
		ledger: Flag.string("ledger").pipe(
			Flag.withDefault(DEFAULT_SPEND_LEDGER_PATH),
			Flag.withDescription("versioned usage ledger path"),
		),
	},
	Effect.fn(function* ({ledger}) {
		yield* emit(yield* runRecord({ledger, stdin: Effect.sync(readStdin)}));
	}),
).pipe(
	Command.withDescription(
		"Record one version-2 usage envelope from stdin. Emits JSON status. Exit 11 means recording failed; retry the same envelope without changing the task result.",
	),
);

export const spendCommand = Command.make("spend").pipe(
	Command.withSubcommands([read, rollup, record]),
	Command.withShortDescription("Record and read model/token usage."),
	Command.withDescription(
		"Record versioned native usage envelopes and read attributed ledger records, or use the legacy transcript and evaluation-summary readers.",
	),
);
