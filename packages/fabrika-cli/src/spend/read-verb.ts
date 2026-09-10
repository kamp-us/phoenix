/** `spend read`: records plus their shared usage summary, or the historical transcript calculation. */
import {Effect, type FileSystem, Result} from "effect";
import {exists, readFile} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INPUT_ABSENT, INPUT_UNREADABLE, NOTHING_MEASURED} from "./codes.ts";
import {classifyRunSpend, type StageSpend} from "./token-spend.ts";
import {readUsageLedger} from "./usage-ledger.ts";
import {rollUpUsage} from "./usage-rollup.ts";

const VERB = "fabrika spend read";

export const runLedgerRead = Effect.fn("spend.readLedger")(function* (path: string) {
	const text = yield* Effect.result(readFile(path));
	if (Result.isFailure(text)) {
		const probe = yield* Effect.result(exists(path));
		const absent = Result.isSuccess(probe) && !probe.success;
		return refuse(
			absent ? INPUT_ABSENT : INPUT_UNREADABLE,
			`spend read: ledger ${absent ? "absent" : "unreadable"}; usage is unknown`,
		);
	}
	const read = readUsageLedger(text.success);
	return answer(JSON.stringify({...read, usage: rollUpUsage(read)}), [
		`spend read: ${read.records.length} attributed record(s), ${read.legacy.length} legacy row(s); ${read.diagnostics.malformed} malformed, ${read.diagnostics.newerVersion} future-version, ${read.diagnostics.duplicates} duplicate, ${read.diagnostics.conflicts} conflicting line(s). Records and notices are not a completeness verdict.`,
	]);
});

export interface ReadOptions {
	/** Path to the run's JSONL transcript. */
	readonly transcript: string;
	readonly json: boolean;
}

/** The header carries the headline; the rows carry the six components it does not. */
const render = (spend: StageSpend): string =>
	[
		`spend\t${spend.billed}\t${spend.assistantTurns}`,
		`input\t${spend.input}`,
		`cacheCreate\t${spend.cacheCreate}`,
		`cacheRead\t${spend.cacheRead}`,
		`output\t${spend.output}`,
		`exCacheRead\t${spend.exCacheRead}`,
		`model\t${spend.model ?? "-"}`,
	].join("\n");

export const runRead = (
	options: ReadOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const path = options.transcript;

		const text = yield* Effect.result(readFile(path));
		if (Result.isFailure(text)) {
			// The read failing is not yet an answer: only a probe that comes back a definite `false`
			// proves the file is absent, and a probe that itself fails proves nothing at all.
			const probe = yield* Effect.result(exists(path));
			if (Result.isFailure(probe) || probe.success) {
				return refuse(
					INPUT_UNREADABLE,
					`${VERB}: cannot read ${path}: ${text.failure.reason} — the spend is UNKNOWN, never zero.`,
				);
			}
		}

		const classified = classifyRunSpend(Result.isFailure(text) ? null : text.success);
		if (classified._tag === "TranscriptMissing") {
			return refuse(INPUT_ABSENT, `${VERB}: no transcript at ${path} — nothing to measure.`);
		}
		if (classified._tag === "NoBilledTurns") {
			return refuse(
				NOTHING_MEASURED,
				`${VERB}: ${path} was read in full and carries zero billed assistant turns — a well-formed zero, not a measured spend.`,
			);
		}

		const spend = classified.spend;
		const scope = `${VERB}: scanned ${path}, ${spend.assistantTurns} billed assistant turn(s); ${spend.cacheRead} of ${spend.billed} billed tokens are cache reads.`;
		return answer(options.json ? JSON.stringify(spend) : render(spend), [scope]);
	});
