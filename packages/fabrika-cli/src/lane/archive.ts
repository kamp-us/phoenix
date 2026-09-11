/**
 * The archive judgement — is this lane's log one no sweep can ever judge?
 *
 * The whole entitlement `lane archive` needs before it moves a directory, the closed-issue gate that
 * used to stand beside it having been retired. This module reads no disk and writes none; the verb's
 * remaining board work is retracting the lane claim, not judging the log.
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
import {foldLog, type LogEntry} from "./fold.ts";
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
