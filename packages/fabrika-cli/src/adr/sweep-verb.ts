/**
 * `adr sweep` — rank the uncited live-accepted records the subject may contradict.
 *
 * **All three outcomes are answers and all three exit 0.** A caller must never read its own
 * shortlist as a failed run, which is precisely the mistake v1's `adr-sweep` makes by exiting 1 on
 * the one case it was asked to produce; and `--json` goes to **stdout**, not stderr (#4723).
 */
import type {FileSystemLike} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {idFromFile, isFourDigitId, partitionRecordNames} from "./records.ts";
import {renderEntry, type SweepCandidate, sweep} from "./sweep.ts";

/** The corpus could not be read, so the outcome is UNKNOWN. */
export const CORPUS_UNREADABLE = 3;
/** `--new` names an id or path with no readable ADR. */
export const NO_SUBJECT = 4;
/** `--dir` was read and held zero records — zero scope (ADR 0092). */
export const ZERO_SCOPE = 5;

export interface SweepOptions {
	/** A four-digit id already in `--dir`, or a path to the draft file. */
	readonly new: string;
	readonly dir: string;
	readonly limit: number;
	readonly json: boolean;
}

export const runSweep = (fs: FileSystemLike, options: SweepOptions): VerbOutcome => {
	const {dir, limit, json} = options;
	const root = dir.replace(/\/+$/, "");

	const names = fs.readDir(root);
	if (names === null) {
		return refuse(
			CORPUS_UNREADABLE,
			`adr sweep: cannot read ${root}: the directory could not be listed — the outcome is UNKNOWN, never "no-overlap".`,
		);
	}
	const {records} = partitionRecordNames(names);
	if (records.length === 0) {
		return refuse(
			ZERO_SCOPE,
			`adr sweep: scanned ${root}, 0 decision records — refusing to answer (ADR 0092).`,
		);
	}

	const corpus: SweepCandidate[] = [];
	for (const file of records) {
		const text = fs.readFile(`${root}/${file}`);
		// One unreadable member makes the corpus INCOMPLETE, and an incomplete corpus is UNKNOWN —
		// silently ranking against the rest would answer from a corpus nobody scanned.
		if (text === null) {
			return refuse(
				CORPUS_UNREADABLE,
				`adr sweep: cannot read ${root}: ${file} could not be read — the outcome is UNKNOWN, never "no-overlap".`,
			);
		}
		corpus.push({id: idFromFile(file) ?? file, file, text});
	}

	const wanted = options.new;
	const byId = isFourDigitId(wanted) ? corpus.find((c) => c.id === wanted) : undefined;
	const subjectText = byId?.text ?? fs.readFile(wanted);
	if (subjectText === null || subjectText === undefined) {
		return refuse(NO_SUBJECT, `adr sweep: no readable ADR for --new ${wanted}.`);
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
};
