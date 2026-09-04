/**
 * `lane archive` — move one lane whose log will never replay out of the swept root.
 *
 * The route ADR 0352 ruled for a lane no sweep can judge. `lane reconcile` reports such a lane
 * `unreadable` and `lane migrate` refuses it `unsafe` on every run, forever, because the fault is in
 * a log neither may rewrite: an `ISSUE.DONE` appended after the fold reached `frozen` has no update
 * cell and never will. Sealing it would mean appending a line for something that did not happen
 * (ADR 0350 forbids that), and giving `frozen` the cell would let a lane at its retry cap ship with
 * no unblock. So the lane leaves the sweep's scope by moving, and the log is never touched.
 *
 * **Both gates hold or nothing moves**, and that is what keeps a genuinely broken lane visible: a
 * lane whose issue is still open, or whose log replays, is refused with the directory where it was.
 * The archived root is a SIBLING of the swept one, so no sweep learns a skip rule — `reconcile` and
 * `migrate` read the roots they are handed, and the archived one is not among them.
 *
 * The order of the two gates is a cost decision: the replay judgement is local and free, the closure
 * read is one request, so a replaying lane is refused before the board is ever asked.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {exists, readFile, rename} from "../io/fs.ts";
import {getIssue, resolveRepo} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {judgeArchive} from "./archive.ts";
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
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane archive";

/** Whether the issue this lane drives is closed on the board. A read that failed is `Unknown`. */
export type ClosureState =
	| {readonly _tag: "Closed"; readonly reason: string | null}
	| {readonly _tag: "Open"}
	| {readonly _tag: "Unknown"; readonly reason: string};

export type ClosedReader<R> = (issue: number) => Effect.Effect<ClosureState, never, R>;

/**
 * The board-backed reader: one `getIssue`, and its `state` is the whole answer.
 *
 * A reader the caller passes rather than a seam this verb reaches through on its own, the shape
 * `lane open` and `lane migrate` established — so every refusal above is testable without a network,
 * and an unreadable board is `Unknown`, never an open issue and never a closed one.
 */
export const closedReader = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): ClosedReader<ChildProcessSpawner.ChildProcessSpawner> => {
	let resolved: string | null = null;
	return (issue) =>
		Effect.gen(function* () {
			if (resolved === null) {
				const attempt = yield* resolveRepo(repo, env);
				if (attempt._tag === "Failure") {
					return {
						_tag: "Unknown" as const,
						reason: "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name",
					};
				}
				resolved = attempt.value;
			}
			const record = yield* getIssue(resolved, issue);
			if (record._tag !== "Present") {
				return {
					_tag: "Unknown" as const,
					reason:
						record._tag === "Absent"
							? `#${issue} is not present on ${resolved}`
							: `cannot read #${issue}: ${record.reason}`,
				};
			}
			return record.value.state === "closed"
				? {_tag: "Closed" as const, reason: record.value.stateReason}
				: {_tag: "Open" as const};
		});
};

export interface ArchiveOptions<R = never> {
	readonly ref: LaneRef;
	/** Where the lane moves to — the archived root, which no sweep is handed. */
	readonly archivedRoot: string;
	/** The committed templates this root's lanes may have booted from; the lane's `id` picks. */
	readonly templatePaths: ReadonlyArray<string>;
	/** The issue this lane drives, or `null` for a key that names none. */
	readonly issue: number | null;
	readonly closed: ClosedReader<R>;
}

export const runArchive = <R = never>(
	options: ArchiveOptions<R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const {ref, issue} = options;
		if (issue === null) {
			return refuse(
				ISSUE_UNRESOLVED,
				`${VERB}: "${ref.lane}" names no issue, and an archive turns on that issue reading closed — a chore lane can never satisfy it, so there is nothing here to prove. Nothing was moved.`,
			);
		}

		const loaded = yield* loadLane(ref);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);

		const workflowPath = path.join(loaded.dir, "workflow.json");
		const laneText = yield* Effect.result(readFile(workflowPath));
		if (Result.isFailure(laneText)) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot re-read ${workflowPath}: ${laneText.failure.reason} — whether this lane replays is UNKNOWN. Nothing was moved.`,
			);
		}
		const templateTexts: string[] = [];
		for (const templatePath of options.templatePaths) {
			const template = yield* Effect.result(readFile(templatePath));
			if (Result.isFailure(template)) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot read the committed template at ${templatePath}: ${template.failure.reason} — nothing was moved.`,
				);
			}
			templateTexts.push(template.success);
		}

		const judged = judgeArchive(templateTexts, laneText.success, loaded.lane, loaded.entries);
		if (judged._tag === "Unjudgeable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot judge whether ${loaded.logPath} replays: ${judged.reason} — refusing to move over UNKNOWN.`,
			);
		}
		if (judged._tag === "Replays") {
			return refuse(
				LOG_REPLAYS,
				`${VERB}: ${loaded.logPath} replays through this lane's own machine and through the committed template, so every sweep can judge it — this is not a lane to move out of their scope. Nothing was moved.`,
			);
		}

		const closure = yield* options.closed(issue);
		if (closure._tag === "Unknown") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot establish whether #${issue} is closed: ${closure.reason} — refusing to move over UNKNOWN.`,
			);
		}
		if (closure._tag === "Open") {
			return refuse(
				ISSUE_LIVE,
				`${VERB}: #${issue} is open, so this lane is live work — an archived lane is beyond every sweep, and a live one belongs where the sweeps can see it. Drive the lane, or close the issue first. Nothing was moved.`,
			);
		}

		const destination = path.join(options.archivedRoot, ref.lane);
		const occupied = yield* Effect.result(exists(destination));
		if (Result.isFailure(occupied)) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot establish whether ${destination} is already there: ${occupied.failure.reason} — refusing to move over UNKNOWN.`,
			);
		}
		if (occupied.success) {
			return refuse(
				LANE_EXISTS,
				`${VERB}: ${destination} already holds an archived lane — a move onto it would bury a record this verb exists to keep. Nothing was moved.`,
			);
		}

		const moved = yield* Effect.result(rename(loaded.dir, destination));
		if (Result.isFailure(moved)) {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: the move of ${loaded.dir} to ${destination} did not land: ${moved.failure.reason} — the lane is NOT archived.`,
			);
		}
		const landed = yield* Effect.result(exists(path.join(destination, "workflow.json")));
		if (Result.isFailure(landed) || !landed.success) {
			return refuse(
				MARKER_READBACK,
				`${VERB}: the move of ${loaded.dir} reported success and ${destination}/workflow.json does not read back — where this lane's record now is needs a human eye before anything else touches it.`,
			);
		}

		return answer(
			JSON.stringify({
				answer: "archived",
				lane: ref.lane,
				issue,
				from: loaded.dir,
				to: destination,
				through: judged.through,
				defects: judged.defects,
			}),
			[
				`${VERB}: moved ${loaded.dir} to ${destination}; #${issue} is closed${closure.reason === null ? "" : ` (${closure.reason})`} and the log does not replay through the ${judged.through === "current" ? "lane's own machine" : "committed template"}.`,
				`${VERB}: read it back with \`fabrika lane history ${ref.lane} --root ${options.archivedRoot}\`.`,
			],
		);
	});
