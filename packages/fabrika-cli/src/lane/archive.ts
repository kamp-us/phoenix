/**
 * The archive judgement — is this lane's log one no sweep can ever judge?
 *
 * The entitlement `lane archive` needs before it moves a directory, the closed-issue gate that used
 * to stand beside it having been retired; {@link judgeRetriage} below is the one other, taken only
 * under `--retriaged`. This module reads no disk and writes none; the verb's remaining board work is
 * retracting the lane claim, not judging the log.
 *
 * The judgement is [`migrate.ts`](migrate.ts)'s, deliberately and by call rather than by
 * re-derivation: the lanes an archive is for are exactly the ones `lane migrate` already refuses as
 * `Unreplayable`, so if the two ever answered differently, the sweep would keep reporting a lane the
 * archive had already taken out of scope, or take one out that the sweep still judges fine.
 *
 * The lane's own machine is folded first, and that ordering is the one thing this adds. A generated
 * epic machine has no committed template to be a candidate ({@link graftContext} answers `Foreign`),
 * so that one fold is the whole judgement: a log it folds `Replays`, because no second machine
 * exists to be unknown about, and one it refuses is `Unreplayable` through `current`. Asking for a
 * candidate first would answer neither.
 */
import {deriveStatus, foldLog, type LogEntry} from "./fold.ts";
import {type CompiledLane, compileText} from "./machine.ts";
import {graftContext, judgeMigration} from "./migrate.ts";

export type ArchiveVerdict =
	/** The log does not replay, and `through` names which machine refused it. */
	| {
			readonly _tag: "Unreplayable";
			readonly through: "current" | "candidate";
			readonly defects: ReadonlyArray<string>;
	  }
	/** The log replays through every machine that exists for the lane — nothing to archive. */
	| {readonly _tag: "Replays"}
	/** A candidate was offered and could not be built, so its verdict is UNKNOWN, never proven. */
	| {readonly _tag: "Unjudgeable"; readonly reason: string};

/**
 * Judge one lane for archiving. `templateTexts` are the committed templates the lane's root binds;
 * the lane's own document `id` picks among them, exactly as the migrate sweep lets it.
 */
export const judgeArchive = (
	templateTexts: ReadonlyArray<string>,
	laneText: string,
	current: CompiledLane,
	entries: ReadonlyArray<LogEntry>,
): ArchiveVerdict => {
	const own = foldLog(current, entries);
	if (own._tag !== "Folded") {
		return {_tag: "Unreplayable", through: "current", defects: own.defects};
	}

	const grafts = templateTexts.map((text) => graftContext(text, laneText));
	const ungraftable = grafts.find((candidate) => candidate._tag === "Ungraftable");
	if (ungraftable !== undefined) return {_tag: "Unjudgeable", reason: ungraftable.reason};
	const graft = grafts.find((candidate) => candidate._tag === "Grafted");
	if (graft === undefined) {
		// A `Foreign` answer is a proven fact, not a gap: this machine was generated, so the fold
		// above ran the only machine the lane has and there is no second one to be unknown about.
		if (grafts.some((candidate) => candidate._tag === "Foreign")) return {_tag: "Replays"};
		return {_tag: "Unjudgeable", reason: "no committed template was offered for this root"};
	}
	const candidate = compileText(graft.text);
	if (candidate._tag === "Malformed") {
		return {
			_tag: "Unjudgeable",
			reason: `the committed template does not compile: ${candidate.defects.join("; ")}`,
		};
	}

	const judged = judgeMigration(current, candidate.lane, entries);
	return judged._tag === "Unreplayable"
		? {_tag: "Unreplayable", through: judged.through, defects: judged.defects}
		: {_tag: "Replays"};
};

/**
 * The re-triage judgement — did this lane end `diagnosed`, with no pull request anywhere in its log?
 *
 * The second thing that entitles `lane archive` to move a lane, and a narrow one. A builder's no-PR
 * finish is final, so once triage rewrites the issue nothing can boot a fresh lane over the ledger
 * standing in the key. Only the lane's own machine is folded: the question is which state this lane
 * is in, not whether a sweep can judge it. A log any line of which names a pull request is refused
 * whatever it folds to, so moving a ledger aside is never how a lane's published work goes unread.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10190
 */
export type RetriageVerdict =
	| {readonly _tag: "Diagnosed"; readonly state: string}
	/** The lane's own machine cannot fold the log — the unreplayable route's lane, not this one's. */
	| {readonly _tag: "Unreplayable"; readonly defects: ReadonlyArray<string>}
	/** The fold ended on some other final, or has not ended at all. */
	| {readonly _tag: "NotDiagnosed"; readonly state: string}
	/** It folds to a diagnosis final, and a line of its log names a pull request. */
	| {readonly _tag: "Published"; readonly pulls: ReadonlyArray<string>};

export const judgeRetriage = (
	current: CompiledLane,
	entries: ReadonlyArray<LogEntry>,
): RetriageVerdict => {
	const folded = foldLog(current, entries);
	if (folded._tag !== "Folded") return {_tag: "Unreplayable", defects: folded.defects};
	const {status, stateValue} = deriveStatus(current, folded.states);
	if (typeof stateValue !== "string") {
		return {_tag: "NotDiagnosed", state: JSON.stringify(stateValue)};
	}
	const diagnosed =
		status === "done" &&
		Object.values(current.tasks).some((task) => task.diagnosisFinals.has(stateValue));
	if (!diagnosed) return {_tag: "NotDiagnosed", state: stateValue};
	const pulls = [
		...new Set(entries.flatMap((entry) => (entry.pr === undefined ? [] : [entry.pr]))),
	];
	return pulls.length > 0 ? {_tag: "Published", pulls} : {_tag: "Diagnosed", state: stateValue};
};
