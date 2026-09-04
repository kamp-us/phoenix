/**
 * The archive judgement — is this lane's log one no sweep can ever judge?
 *
 * Half of what `lane archive` needs before it moves a directory; the other half (the issue reads
 * closed) is a board fact and lives at the verb. This module reads no disk and writes none.
 *
 * The judgement is [`migrate.ts`](migrate.ts)'s, deliberately and by call rather than by
 * re-derivation: the lanes an archive is for are exactly the ones `lane migrate` already refuses as
 * `Unreplayable`, so if the two ever answered differently, the sweep would keep reporting a lane the
 * archive had already taken out of scope, or take one out that the sweep still judges fine (ADR
 * 0352).
 *
 * The lane's own machine is folded first, and that ordering is the one thing this adds. A generated
 * epic machine has no committed template to be a candidate ({@link graftContext} answers `Foreign`),
 * so asking for a candidate first would leave every emitted lane unjudgeable — including one whose
 * log genuinely does not replay through the only machine it has.
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
	/** The log replays through every machine that can be built for it — nothing to archive. */
	| {readonly _tag: "Replays"}
	/** No candidate could be built, so replayability through the template is UNKNOWN, never proven. */
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
		const foreign = grafts.find((candidate) => candidate._tag === "Foreign");
		return {
			_tag: "Unjudgeable",
			reason:
				foreign === undefined
					? "no committed template was offered for this root"
					: `machine "${foreign.id}" was generated, not booted, so it has no committed template to be judged against`,
		};
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
