/**
 * `lane archive --sweep` — archive every lane in a root that both gates already clear.
 *
 * The verb existed and nothing called it in bulk, so the seats a dead lane holds against
 * `laneConcurrencyCap` only ever went down by hand: one repo reached eleven claimed seats against a
 * cap of two, nine of them corpses whose issue was closed and whose log will never replay. One lane
 * at a time is a loop nobody runs to the end, the same reason `lane migrate` and `lane stale` sweep.
 *
 * Every lane is judged on its own and a refusal is a ROW, never the end of the sweep — the single
 * fatal answer is a root that could not be listed, because an unreadable root makes the lane set
 * UNKNOWN rather than empty. The gates are {@link archiveLane}'s, and they stay BOTH gates: the
 * closed-issue one was retired from the named single-lane route only, on the argument that an
 * operator naming one bricked lane by hand has already judged it. Nothing has ruled the same for an
 * unattended walk of the whole root, and this sweep retracts no claim, so a lane it moves is a
 * strictly narrower set than `lane archive <key>` would move.
 *
 * A key that resolves to no issue is skipped and NAMED rather than fatal: the quarantine convention
 * puts `<issue>.<suffix>` directories in the root, and a root holding one unaddressable name must
 * not cost every other lane its sweep.
 *
 * A row has three outcomes, not two, because "skipped" asserts the directory is where it was: a lane
 * whose rename landed and whose destination will not read back is `moved-unverified` instead.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import {exists, readDir} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {type ArchiveOutcome, archiveLane, type ClosedReader} from "./archive-move.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE, MARKER_READBACK} from "./codes.ts";
import {resolveKeyIssue} from "./key.ts";

const VERB = "fabrika lane archive --sweep";

export interface ArchiveSweepOptions<R = never> {
	/** The lanes root to walk. One root: the archived root is its sibling, and chores archive never. */
	readonly root: string;
	readonly archivedRoot: string;
	/** The committed templates a lane in this root may have booted from; the lane's `id` picks. */
	readonly templatePaths: ReadonlyArray<string>;
	readonly closed: ClosedReader<R>;
}

/**
 * Why a lane was left where it was. A closed set, because the operator's next move differs by arm
 * and a prose reason nothing keys on sends every skip to the same place.
 */
export type SkipReason =
	| "replays"
	| "issue-open"
	| "unjudgeable"
	| "no-issue"
	| "unreadable"
	| "occupied"
	| "unmoved";

export type SweepRow =
	| {
			readonly key: string;
			readonly outcome: "archived";
			readonly issue: number;
			readonly from: string;
			readonly to: string;
			readonly through: "current" | "candidate";
	  }
	| {
			readonly key: string;
			readonly outcome: "skipped";
			readonly reason: SkipReason;
			readonly detail: string;
	  }
	// The lane whose rename landed and whose destination will not read back is neither archived nor
	// skipped: calling it skipped says the directory is where it was, which is the one thing the
	// operator now knows is false.
	| {
			readonly key: string;
			readonly outcome: "moved-unverified";
			readonly from: string;
			readonly to: string;
			readonly detail: string;
	  };

const skipped = (key: string, reason: SkipReason, detail: string): SweepRow => ({
	key,
	outcome: "skipped",
	reason,
	detail,
});

/** Every arm of the shared judgement, read as a row. Nothing here decides; the move already did. */
const rowOf = (key: string, outcome: ArchiveOutcome): SweepRow => {
	switch (outcome._tag) {
		case "Archived":
			return {
				key,
				outcome: "archived",
				issue: outcome.issue,
				from: outcome.from,
				to: outcome.to,
				through: outcome.through,
			};
		case "NoIssue":
			return skipped(
				key,
				"no-issue",
				outcome.kind === "Chore"
					? "a chore lane drives no issue, so the closed-issue gate can never hold"
					: "the directory name carries no leading issue number, so no board read can be made for it",
			);
		case "Unloadable":
			return skipped(
				key,
				"unreadable",
				outcome.loaded._tag === "Absent"
					? `no lane record at ${outcome.loaded.dir}`
					: outcome.loaded._tag === "Unreadable"
						? `cannot read ${outcome.loaded.path}: ${outcome.loaded.reason}`
						: `${outcome.loaded.path} is not the shape: ${outcome.loaded.defects.join("; ")}`,
			);
		case "WorkflowUnreadable":
			return skipped(key, "unreadable", `cannot re-read ${outcome.path}: ${outcome.reason}`);
		case "TemplateUnreadable":
			return skipped(
				key,
				"unreadable",
				`cannot read the committed template at ${outcome.path}: ${outcome.reason}`,
			);
		case "Unjudgeable":
			return skipped(
				key,
				"unjudgeable",
				`cannot judge whether ${outcome.logPath} replays: ${outcome.reason} — UNKNOWN is never archived`,
			);
		case "Replays":
			return skipped(
				key,
				"replays",
				`${outcome.logPath} replays through every machine that exists for this lane`,
			);
		case "ClosureUnknown":
			return skipped(
				key,
				"unreadable",
				`cannot establish whether #${outcome.issue} is closed: ${outcome.reason}`,
			);
		case "IssueOpen":
			return skipped(key, "issue-open", `#${outcome.issue} is open, so this lane is live work`);
		case "Unprobeable":
			return skipped(
				key,
				"unreadable",
				`cannot establish whether ${outcome.destination} is already there: ${outcome.reason}`,
			);
		case "Occupied":
			return skipped(
				key,
				"occupied",
				`${outcome.destination} already holds an archived lane — a move onto it would bury a record`,
			);
		case "Unmoved":
			return skipped(
				key,
				"unmoved",
				`the move of ${outcome.from} to ${outcome.to} did not land: ${outcome.reason} — the lane is NOT archived`,
			);
		case "Unverified":
			return {
				key,
				outcome: "moved-unverified",
				from: outcome.from,
				to: outcome.to,
				detail: `the move of ${outcome.from} reported success and ${outcome.to}/workflow.json does not read back`,
			};
	}
};

export const runArchiveSweep = <R = never>(
	options: ArchiveSweepOptions<R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const probe = yield* Effect.result(exists(options.root));
		if (Result.isFailure(probe)) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot establish whether ${options.root} is there: ${probe.failure.reason} — the lane set is UNKNOWN, never empty. Nothing was moved.`,
			);
		}
		if (!probe.success) {
			return answer(
				JSON.stringify({answer: "swept", root: options.root, present: false, lanes: []}, null, 2),
				[`${VERB}: ${options.root} is not there, so it holds no lanes. Nothing was moved.`],
			);
		}
		const names = yield* Effect.result(readDir(options.root));
		if (Result.isFailure(names)) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot list ${options.root}: ${names.failure.reason} — the lane set is UNKNOWN, never empty. Nothing was moved.`,
			);
		}

		const lanes: SweepRow[] = [];
		for (const name of [...names.success].sort()) {
			// An entry with no workflow.json is not a lane at all — a scratch directory under the root
			// is not a skip to report, and reporting it would put noise in front of every real row.
			const present = yield* Effect.result(exists(path.join(options.root, name, "workflow.json")));
			if (Result.isSuccess(present) && !present.success) continue;
			const outcome = yield* archiveLane({
				ref: {root: options.root, lane: name},
				archivedRoot: options.archivedRoot,
				templatePaths: options.templatePaths,
				issue: resolveKeyIssue({_tag: "Issue", lane: name}),
				closed: options.closed,
			});
			lanes.push(rowOf(name, outcome));
		}

		const archived = lanes.filter((row) => row.outcome === "archived");
		const unverified = lanes.filter((row) => row.outcome === "moved-unverified");
		const stderr = [
			`${VERB}: swept ${options.root} — ${lanes.length} lane(s) examined, ${archived.length} archived${unverified.length > 0 ? `, ${unverified.length} moved and unverified` : ""}.`,
			...lanes.map((row) => {
				if (row.outcome === "archived") {
					return `${VERB}: ${row.key}: archived to ${row.to} (#${row.issue} is closed; the log does not replay through the ${row.through === "current" ? "lane's own machine" : "committed template"}).`;
				}
				if (row.outcome === "moved-unverified") {
					return `${VERB}: ${row.key}: moved to ${row.to} and unverified — ${row.detail}.`;
				}
				return `${VERB}: ${row.key}: skipped (${row.reason}) — ${row.detail}.`;
			}),
		];

		// A half-landed move is the one row a clean sweep may not absorb: the readback failure needs a
		// human eye before anything else touches that record, and a move that did not land leaves a
		// lane the operator still believes is archived. Every row reaches stderr either way, so a
		// refusal here still enumerates what did move.
		if (unverified.length > 0) {
			return refuse(
				MARKER_READBACK,
				`${VERB}: ${unverified.length} lane(s) moved and do not read back at the archived root: ${unverified.map((row) => row.key).join(", ")}. Where those records now are needs a human eye before anything else touches them.`,
				stderr,
			);
		}
		const unmoved = lanes.filter((row) => row.outcome === "skipped" && row.reason === "unmoved");
		if (unmoved.length > 0) {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: ${unmoved.length} lane(s) cleared both gates and their move did not land: ${unmoved.map((row) => row.key).join(", ")}. Those lanes are NOT archived; ${archived.length} other lane(s) were.`,
				stderr,
			);
		}

		return answer(
			JSON.stringify(
				{
					answer: "swept",
					root: options.root,
					present: true,
					archivedRoot: options.archivedRoot,
					examined: lanes.length,
					archived: archived.length,
					lanes,
				},
				null,
				2,
			),
			stderr,
		);
	});
