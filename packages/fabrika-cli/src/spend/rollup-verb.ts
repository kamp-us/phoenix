/**
 * `spend rollup` — one command that answers what fabrika's runs cost, from persisted data (#5010).
 *
 * It reads the durable ledger and nothing else: no transcript is re-parsed, no process is spawned,
 * no operator supplies a path to a run. That is what makes it the epic's acceptance test — a number
 * a human or an agent can ask for on demand without slowing a lane.
 *
 * **It cannot gate.** No threshold flag, no budget option, and no exit code that varies with the
 * size of a total (epic #4779's no-gate ruling). The non-zero codes below are all about whether an
 * answer could be *produced*, never about how big it was.
 *
 * The four refusals are the same discipline `spend read` draws, one level up: an absent ledger, an
 * unreadable one, one that holds no rows at all, and a window that selects none of the rows it does
 * hold are four different facts, and none of them is a zero total.
 */
import {Effect, type FileSystem, Result} from "effect";
import {exists, readFile} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	INPUT_ABSENT,
	INPUT_UNREADABLE,
	NOTHING_MEASURED,
	WINDOW_SELECTED_NO_ROWS,
} from "./codes.ts";
import {readSpendLedger} from "./ledger.ts";
import {
	type ResolvedWindow,
	type Rollup,
	resolveBound,
	rollUp,
	type SpendTotals,
} from "./rollup.ts";

const VERB = "fabrika spend rollup";

export interface RollupOptions {
	/** Path to the durable spend ledger. */
	readonly ledger: string;
	/** Inclusive lower bound, or `null` for unbounded. */
	readonly since: string | null;
	/** Inclusive upper bound, or `null` for unbounded. A bare date means through that whole UTC day. */
	readonly until: string | null;
	readonly json: boolean;
}

const totalsFields = (totals: SpendTotals): ReadonlyArray<string> => [
	String(totals.billed),
	String(totals.exCacheRead),
	String(totals.assistantTurns),
	String(totals.runs),
	String(totals.measuredRuns),
];

/**
 * One record per line, first field naming the record's kind — so `grep '^day'` is the breakdown and
 * the unread counts sit in the same answer as the total they qualify.
 */
const render = (rollup: Rollup): string => {
	const t = rollup.totals;
	return [
		`billed\t${t.billed}`,
		`exCacheRead\t${t.exCacheRead}`,
		`assistantTurns\t${t.assistantTurns}`,
		`runs\t${t.runs}`,
		`measuredRuns\t${t.measuredRuns}`,
		`skipped\t${rollup.skipped.total}`,
		`skippedMalformed\t${rollup.skipped.malformed}`,
		`skippedNewerVersion\t${rollup.skipped.newerVersion}`,
		`undatedRows\t${rollup.undatedRows}`,
		...rollup.byDay.map((b) => [`day\t${b.day}`, ...totalsFields(b)].join("\t")),
		...rollup.bySkill.map((b) => [`skill\t${b.skill}`, ...totalsFields(b)].join("\t")),
		...rollup.byStageArm.map((b) =>
			[`stage-arm\t${b.stage}\t${b.arm}`, ...totalsFields(b)].join("\t"),
		),
	].join("\n");
};

/**
 * How many lines the ledger held but could not yield, said in words — appended to every outcome,
 * answer and refusal alike. A caller who reads only the total still sees the gap, which is the
 * whole point: a rollup that skipped 40 lines and says nothing is a smaller number that looks whole.
 */
const skippedNote = (skipped: {
	readonly total: number;
	readonly malformed: number;
	readonly newerVersion: number;
}): string =>
	skipped.total === 0
		? "every line in the ledger was read."
		: `${skipped.total} ledger line(s) could NOT be read and are absent from these figures: ${skipped.malformed} malformed (damage — those measurements are gone), ${skipped.newerVersion} written by a newer row version (upgrade fabrika-cli to include them).`;

export const runRollup = (
	options: RollupOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const path = options.ledger;

		const sinceAt = options.since === null ? null : resolveBound(options.since, "since");
		const untilAt = options.until === null ? null : resolveBound(options.until, "until");
		if (options.since !== null && sinceAt === null) {
			return refuse(FAILED, `${VERB}: --since ${options.since} is not a time.`);
		}
		if (options.until !== null && untilAt === null) {
			return refuse(FAILED, `${VERB}: --until ${options.until} is not a time.`);
		}
		const window: ResolvedWindow = {
			sinceAt,
			untilAt,
			text: {since: options.since, until: options.until},
		};

		const text = yield* Effect.result(readFile(path));
		if (Result.isFailure(text)) {
			// Only a probe that comes back a definite `false` proves the ledger is absent; a probe that
			// itself fails proves nothing, so it stays UNKNOWN rather than becoming "nothing recorded".
			const probe = yield* Effect.result(exists(path));
			if (Result.isFailure(probe) || probe.success) {
				return refuse(
					INPUT_UNREADABLE,
					`${VERB}: cannot read the ledger at ${path}: ${text.failure.reason} — the spend is UNKNOWN, never zero.`,
				);
			}
			return refuse(
				INPUT_ABSENT,
				`${VERB}: no spend ledger at ${path} — nothing has been recorded yet.`,
			);
		}

		const read = readSpendLedger(text.success);
		const skipped = {total: read.skipped, ...read.skips};
		if (read.rows.length === 0) {
			return refuse(
				NOTHING_MEASURED,
				`${VERB}: ${path} was read in full and yielded no rows — nothing to sum.`,
				[`${VERB}: ${skippedNote(skipped)}`],
			);
		}

		const rollup = rollUp(read, window);
		const bounds = `${options.since ?? "the first row"} .. ${options.until ?? "the last row"}`;
		if (rollup.totals.runs === 0) {
			return refuse(
				WINDOW_SELECTED_NO_ROWS,
				`${VERB}: ${read.rows.length} row(s) in ${path}, none of them within ${bounds} — an empty window, not an empty ledger.`,
				[`${VERB}: ${skippedNote(skipped)}`],
			);
		}

		const scope = `${VERB}: summed ${rollup.totals.runs} run(s) from ${path} within ${bounds}; ${rollup.totals.measuredRuns} carried a reconstructed spend. ${skippedNote(skipped)}${rollup.undatedRows === 0 ? "" : ` ${rollup.undatedRows} row(s) carry no readable timestamp and this bounded window excluded them.`}`;
		return answer(options.json ? JSON.stringify(rollup) : render(rollup), [scope]);
	});
