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
			Argument.withDescription("path to the run's JSONL transcript; never given with --ledger"),
		),
		ledger: Flag.string("ledger").pipe(
			Flag.optional,
			Flag.withDescription(
				"read versioned usage records from this ledger instead of a transcript; always emits JSON",
			),
		),
		json: Flag.boolean("json").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"emit a transcript's eight fields as JSON on stdout instead of the line grammar",
			),
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
		[
			"Prints a ledger's JSON {records, legacy, diagnostics, usage}, or a transcript's `spend\\t…` lines.",
			"  7: the input is absent",
			"  11: the input is unreadable",
			"  12: the transcript has no billed turns",
			'  Derivation: packages/fabrika-cli/docs/usage-recording.md, "Entry points"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"node packages/fabrika-cli/src/bin.ts spend read --ledger .fabrika/spend-ledger.jsonl --json",
		},
	]),
);

const rollup = leafCommand(
	"rollup",
	{
		issue: Flag.integer("issue").pipe(
			Flag.optional,
			Flag.withDescription(
				"select the recorded issue number; unattributed work remains excluded and counted",
			),
		),
		run: Flag.string("run").pipe(
			Flag.optional,
			Flag.withDescription("select the exact recorded run ID, including unattributed issue usage"),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription("select the exact recorded owner/repository"),
		),
		// `--ledger`, not `--spend-ledger`: inside `fabrika spend rollup` the group name is already
		// said.
		ledger: Flag.string("ledger").pipe(
			Flag.withDefault(DEFAULT_SPEND_LEDGER_PATH),
			Flag.withDescription(
				`the usage ledger to read, one versioned record per JSON line (default: ${DEFAULT_SPEND_LEDGER_PATH})`,
			),
		),
		since: Flag.string("since").pipe(
			Flag.optional,
			Flag.withDescription(
				"inclusive lower bound — an ISO-8601 instant, or a bare YYYY-MM-DD meaning that UTC day's first millisecond; historical ledgers only, refused once version-2 rows exist",
			),
		),
		until: Flag.string("until").pipe(
			Flag.optional,
			Flag.withDescription(
				"inclusive upper bound — an ISO-8601 instant, or a bare YYYY-MM-DD meaning through that whole UTC day; historical ledgers only, refused once version-2 rows exist",
			),
		),
		json: Flag.boolean("json").pipe(
			Flag.withDefault(false),
			Flag.withDescription("emit the same answer as JSON on stdout instead of the line grammar"),
		),
	},
	Effect.fn(function* ({ledger, since, until, issue, run, repo, json}) {
		yield* emit(
			yield* runRollup({
				ledger,
				since: since._tag === "Some" ? since.value : null,
				until: until._tag === "Some" ? until.value : null,
				json,
				issue: issue._tag === "Some" ? issue.value : null,
				run: run._tag === "Some" ? run.value : null,
				repo: repo._tag === "Some" ? repo.value : null,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Issue/run model and token totals with explicit coverage."),
	Command.withDescription(
		[
			"Prints historical totals and breakdowns, then `legacy\\t<JSON>` and `usage.<field>\\t<JSON>` lines.",
			"  7: the ledger is absent",
			"  11: the ledger is unreadable",
			"  12: the ledger has no readable rows",
			"  13: the historical date window is empty",
			'  Derivation: packages/fabrika-cli/docs/usage-recording.md, "Issue and run summaries"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "node packages/fabrika-cli/src/bin.ts spend rollup --issue 42 --json"},
	]),
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
	Command.withShortDescription("Record one native model and token usage envelope."),
	Command.withDescription(
		[
			'Records one version-2 usage envelope from stdin and prints {"status":"recorded"|"duplicate"}.',
			"  11: recording failed; retry the same envelope",
			'  Derivation: packages/fabrika-cli/docs/usage-recording.md, "Entry points"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"node packages/fabrika-cli/src/bin.ts spend record --ledger .fabrika/example-usage.jsonl < packages/fabrika-cli/src/spend/fixtures/attributed/codex.json",
		},
	]),
);

export const spendCommand = Command.make("spend").pipe(
	Command.withSubcommands([read, rollup, record]),
	Command.withShortDescription("Record and read model/token usage."),
	Command.withDescription(
		"Record native usage envelopes and read issue/run model and token totals with coverage, alongside labelled historical views.",
	),
);
