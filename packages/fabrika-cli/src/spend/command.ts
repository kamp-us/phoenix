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
		"Read either a positional legacy transcript or --ledger <path>, never both. Ledger mode always emits JSON {records, legacy, diagnostics, usage}. usage is the same unfiltered response/model/category and coverage summary as spend rollup. diagnostics counts malformed, newerVersion, duplicates and conflicts; conflicting identities and cumulative snapshots do not enter usage totals. Pi coverage remains unavailable. Legacy transcript mode emits spend\\t<billed>\\t<assistantTurns>, then input, cacheCreate, cacheRead, output, exCacheRead and model rows; --json emits those eight fields. Legacy model attribution is the last observed model, not a per-response breakdown. Exits 1 (ambiguous or missing input), 7 (input absent), 11 (input unreadable), 12 (legacy transcript has no billed turns). Example: node packages/fabrika-cli/src/bin.ts spend read --ledger .fabrika/spend-ledger.jsonl --json",
	),
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
		"Sum recorded response counters by native host/format/provider/model, preserving additive, subset, aggregate and unknown meanings. --issue, --run and --repo intersect exact recorded bindings. Unattributed responses remain in run/overall totals and are counted as excluded by an issue filter. JSON adds usage {scope, responses, counters, byModel, excluded, unattributed, coverage, diagnostics} and legacy metadata to the historical window/totals/skipped/undatedRows/byDay/bySkill/byStageArm fields. Text retains the historical billed/exCacheRead/assistantTurns/runs/measuredRuns and skipped/skippedMalformed/skippedNewerVersion/undatedRows lines, then day/skill/stage-arm rows capped at ten each with dayMore/skillMore/stageArmMore; Each legacy breakdown row starts with day\\t<day>, skill\\t<skill> or stage-arm\\t<stage>\\t<arm>, followed by billed, exCacheRead, assistantTurns, runs and measuredRuns in that order. JSON byDay/bySkill/byStageArm are each {rows, more}; each row has those five totals plus day, skill, or stage and arm respectively. The usage fields are defined in packages/fabrika-cli/docs/usage-recording.md under Issue and run summaries. It appends legacy\\t<JSON> and usage.<field>\\t<JSON> for every usage field. Category tokens are null without a measurement; states counts distinguish measured zero, absent, unsupported, unavailable and not-applicable. Cumulative snapshots and conflicting identities are excluded. Coverage names missing participants and unknown discovery; Pi is unavailable. Legacy rows have no modern attribution and are excluded by binding filters. --since/--until accept inclusive instants or whole UTC dates for legacy-only ledgers; they refuse when version-2 rows exist because those rows have no timestamps. Exits 1 (invalid dates or modern date filtering), 7 (ledger absent), 11 (unreadable), 12 (no readable rows), 13 (empty legacy date window). No native parsing, prices or task-result changes. Example: node packages/fabrika-cli/src/bin.ts spend rollup --issue 42 --json",
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
	Command.withShortDescription("Record one native model and token usage envelope."),
	Command.withDescription(
		"Record one version-2 usage envelope from stdin. Emits JSON status. Exit 11 means recording failed; retry the same envelope without changing the task result.",
	),
);

export const spendCommand = Command.make("spend").pipe(
	Command.withSubcommands([read, rollup, record]),
	Command.withShortDescription("Record and read model/token usage."),
	Command.withDescription(
		"Record native usage envelopes and read issue/run model and token totals with coverage, alongside labelled historical views.",
	),
);
