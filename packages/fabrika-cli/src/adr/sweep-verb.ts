/**
 * `adr sweep` — rank the uncited live-accepted records the subject may contradict.
 *
 * **All three outcomes are answers and all three exit 0.** A caller must never read its own
 * shortlist as a failed run, which is precisely the mistake v1's `adr-sweep` makes by exiting 1 on
 * the one case it was asked to produce; and `--json` goes to **stdout**, not stderr (#4723).
 *
 * A readable-but-empty `--dir` is the rarity floor at its limit, so it answers `indeterminate` and
 * needs no case of its own; only an unreadable corpus is UNKNOWN.
 */
import {Effect, type FileSystem, Result} from "effect";
import {readDir, readFile} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {DIR_UNREADABLE, NO_SUBJECT} from "./codes.ts";
import {idFromFile, isFourDigitId, partitionRecordNames} from "./records.ts";
import {renderEntry, type SweepCandidate, sweep} from "./sweep.ts";

export interface SweepOptions {
	/** A four-digit id already in `--dir`, or a path to the draft file. */
	readonly new: string;
	readonly dir: string;
	readonly limit: number;
	readonly json: boolean;
}

export const runSweep = (
	options: SweepOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const {dir, limit, json} = options;
		const root = dir.replace(/\/+$/, "");

		const listing = yield* Effect.result(readDir(root));
		if (Result.isFailure(listing)) {
			return refuse(
				DIR_UNREADABLE,
				`adr sweep: cannot read ${root}: the directory could not be listed — the outcome is UNKNOWN, never "no-overlap".`,
			);
		}
		const {records} = partitionRecordNames(listing.success);

		const corpus: SweepCandidate[] = [];
		for (const file of records) {
			const text = yield* Effect.result(readFile(`${root}/${file}`));
			// One unreadable member makes the corpus INCOMPLETE, and an incomplete corpus is UNKNOWN —
			// silently ranking against the rest would answer from a corpus nobody scanned.
			if (Result.isFailure(text)) {
				return refuse(
					DIR_UNREADABLE,
					`adr sweep: cannot read ${root}: ${file} could not be read — the outcome is UNKNOWN, never "no-overlap".`,
				);
			}
			corpus.push({id: idFromFile(file) ?? file, file, text: text.success});
		}

		const wanted = options.new;
		const byId = isFourDigitId(wanted) ? corpus.find((c) => c.id === wanted) : undefined;
		let subjectText = byId?.text;
		if (subjectText === undefined) {
			const draft = yield* Effect.result(readFile(wanted));
			if (Result.isFailure(draft)) {
				return refuse(NO_SUBJECT, `adr sweep: no readable ADR for --new ${wanted}.`);
			}
			subjectText = draft.success;
		}
		const subjectId = byId?.id ?? idFromFile(wanted.split("/").pop() ?? "");

		if (limit < 0) return refuse(FAILED, `adr sweep: --limit ${limit} is negative.`);

		const result = sweep({id: subjectId, text: subjectText}, corpus, limit);
		const scope = `adr sweep: scanned ${root}, ${result.scanned} decision records; ${result.inScope} uncited live-accepted record(s) in scope (${result.cited} already cited).`;
		const diagnostics = result.reason === null ? [scope] : [scope, `adr sweep: ${result.reason}.`];

		if (json) {
			return answer(
				JSON.stringify({
					outcome: result.outcome,
					entries: result.entries,
					reason: result.reason,
					scanned: result.scanned,
					inScope: result.inScope,
					cited: result.cited,
				}),
				diagnostics,
			);
		}
		return answer([result.outcome, ...result.entries.map(renderEntry)].join("\n"), diagnostics);
	});
