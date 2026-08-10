/**
 * `spend read` — one fabrika run's billed token spend, reconstructed from its transcript.
 *
 * The meter is imported, never re-derived: `token-spend.ts` owns the four-component sum, and a
 * second one here is the two-rulers problem its own header already argues against.
 *
 * The three refusals below are the point of the verb. A measurement that cannot be made must not
 * resolve to a plausible zero, so "the transcript is not there", "the transcript could not be read"
 * and "the transcript was read in full and billed nothing" stay three distinct exit codes — the same
 * split `token-spend.ts`'s `RunSpend` union draws, which is why the classification is borrowed from
 * there rather than restated.
 */
import {Effect, type FileSystem, Result} from "effect";
import {exists, readFile} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INPUT_ABSENT, INPUT_UNREADABLE, NOTHING_MEASURED} from "./codes.ts";
import {classifyRunSpend, type StageSpend} from "./token-spend.ts";

const VERB = "fabrika spend read";

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
