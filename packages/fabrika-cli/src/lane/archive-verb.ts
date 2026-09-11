/**
 * `lane archive` — move one lane whose log will never replay out of the swept root.
 *
 * The route for a lane no sweep can judge. `lane reconcile` reports such a lane
 * `unreadable` and `lane migrate` refuses it `unsafe` on every run, forever, because the fault is in
 * a log neither may rewrite: an `ISSUE.DONE` appended after the fold reached `frozen` has no update
 * cell and never will. Sealing it would mean appending a line for something that did not happen —
 * the log is append-only and a recorded line is never rewritten — and giving `frozen` the cell
 * would let a lane at its retry cap ship with no unblock. So the lane leaves the sweep's scope by
 * moving, and the log is never touched.
 *
 * **Both gates hold or nothing moves**, and that is what keeps a genuinely broken lane visible: a
 * lane whose issue is still open, or whose log replays, is refused with the directory where it was.
 * The archived root is a SIBLING of the swept one, so no sweep learns a skip rule — `reconcile` and
 * `migrate` read the roots they are handed, and the archived one is not among them.
 *
 * The gates themselves are [`archive-move.ts`](archive-move.ts)'s, shared with the sweep
 * ([`archive-sweep-verb.ts`](archive-sweep-verb.ts)); this module is the single-lane wording and
 * exit code over them.
 */
import {Effect, type FileSystem, type Path} from "effect";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {type ArchiveMove, type ArchiveOutcome, archiveLane} from "./archive-move.ts";
import {
	APPEND_UNKNOWN,
	ISSUE_LIVE,
	ISSUE_UNRESOLVED,
	LANE_EXISTS,
	LANE_UNREADABLE,
	LOG_REPLAYS,
	MARKER_READBACK,
} from "./codes.ts";
import {loadRefusal} from "./refusals.ts";
import type {LaneRef} from "./store.ts";

const VERB = "fabrika lane archive";

export type ArchiveOptions<R = never> = ArchiveMove<R>;

/** One lane's proven outcome, worded and seated. Exhaustive: a new arm reds the compiler here. */
const verdictOf = (ref: LaneRef, archivedRoot: string, outcome: ArchiveOutcome): VerbOutcome => {
	switch (outcome._tag) {
		case "NoIssue":
			return refuse(
				ISSUE_UNRESOLVED,
				outcome.kind === "Chore"
					? `${VERB}: "${ref.lane}" is a chore lane, and an archive turns on an issue reading closed — a lane with no issue can never satisfy it, so there is nothing here to prove. Nothing was moved.`
					: `${VERB}: "${ref.lane}" carries no leading issue number, so there is no issue for the closed-issue gate to read — this is not a chore lane, so what is wrong is the directory name. A quarantined lane is named "<issue>.<suffix>" precisely so it keeps naming its issue. Nothing was moved.`,
			);
		case "Unloadable":
			return loadRefusal(VERB, outcome.loaded);
		case "WorkflowUnreadable":
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot re-read ${outcome.path}: ${outcome.reason} — whether this lane replays is UNKNOWN. Nothing was moved.`,
			);
		case "TemplateUnreadable":
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read the committed template at ${outcome.path}: ${outcome.reason} — nothing was moved.`,
			);
		case "Unjudgeable":
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot judge whether ${outcome.logPath} replays: ${outcome.reason} — refusing to move over UNKNOWN.`,
			);
		case "Replays":
			return refuse(
				LOG_REPLAYS,
				`${VERB}: ${outcome.logPath} replays through every machine that exists for this lane, so every sweep can judge it — this is not a lane to move out of their scope. Nothing was moved.`,
			);
		case "ClosureUnknown":
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot establish whether #${outcome.issue} is closed: ${outcome.reason} — refusing to move over UNKNOWN.`,
			);
		case "IssueOpen":
			return refuse(
				ISSUE_LIVE,
				`${VERB}: #${outcome.issue} is open, so this lane is live work — an archived lane is beyond every sweep, and a live one belongs where the sweeps can see it. Drive the lane, or close the issue first. Nothing was moved.`,
			);
		case "Unprobeable":
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot establish whether ${outcome.destination} is already there: ${outcome.reason} — refusing to move over UNKNOWN.`,
			);
		case "Occupied":
			return refuse(
				LANE_EXISTS,
				`${VERB}: ${outcome.destination} already holds an archived lane — a move onto it would bury a record this verb exists to keep. Nothing was moved.`,
			);
		case "Unmoved":
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: the move of ${outcome.from} to ${outcome.to} did not land: ${outcome.reason} — the lane is NOT archived.`,
			);
		case "Unverified":
			return refuse(
				MARKER_READBACK,
				`${VERB}: the move of ${outcome.from} reported success and ${outcome.to}/workflow.json does not read back — where this lane's record now is needs a human eye before anything else touches it.`,
			);
		case "Archived":
			return answer(
				JSON.stringify({
					answer: "archived",
					lane: ref.lane,
					issue: outcome.issue,
					from: outcome.from,
					to: outcome.to,
					through: outcome.through,
					defects: outcome.defects,
				}),
				[
					`${VERB}: moved ${outcome.from} to ${outcome.to}; #${outcome.issue} is closed${outcome.closedReason === null ? "" : ` (${outcome.closedReason})`} and the log does not replay through the ${outcome.through === "current" ? "lane's own machine" : "committed template"}.`,
					`${VERB}: read it back with \`fabrika lane history ${ref.lane} --root ${archivedRoot}\`.`,
				],
			);
	}
};

export const runArchive = <R = never>(
	options: ArchiveOptions<R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.map(archiveLane(options), (outcome) =>
		verdictOf(options.ref, options.archivedRoot, outcome),
	);
