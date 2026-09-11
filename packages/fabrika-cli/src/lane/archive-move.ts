/**
 * The gated move one lane takes when its log will never replay — the whole of `lane archive`'s
 * decision, with none of its wording.
 *
 * Split out of the verb because two callers now make it: `lane archive <lane>`, which turns one
 * outcome into one refusal, and `lane archive --sweep`, which turns many into rows. A sweep that
 * re-derived the gates would be a second judgement of the same question, free to drift from the
 * single-lane one — and the drift that matters here moves a live lane out of every sweep's sight.
 *
 * Every arm below is a PROVEN fact about one lane, never a message: the verb composes the prose, so
 * the sweep is not stuck parsing a refusal to find out what happened. The order of the two gates is
 * a cost decision kept from the verb: the replay judgement is local and free, the closure read is
 * one request, so a replaying lane is refused before the board is ever asked.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {exists, readFile, rename} from "../io/fs.ts";
import {getIssue, resolveRepo} from "../io/issues.ts";
import {judgeArchive} from "./archive.ts";
import type {KeyIssue} from "./key.ts";
import {type LaneRef, type LoadedLane, loadLane} from "./store.ts";

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
 * and an unreadable board is `Unknown`, never an open issue and never a closed one. The repo is
 * resolved once and held, so a sweep of fifty lanes still costs one resolution.
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

export interface ArchiveMove<R = never> {
	readonly ref: LaneRef;
	/** Where the lane moves to — the archived root, which no sweep is handed. */
	readonly archivedRoot: string;
	/** The committed templates this root's lanes may have booted from; the lane's `id` picks. */
	readonly templatePaths: ReadonlyArray<string>;
	/** The issue this lane drives, or which of the two ways its key names none. */
	readonly issue: KeyIssue;
	readonly closed: ClosedReader<R>;
}

/** Every `loadLane` answer that is not a lane — the three a caller routes, none of them a fold. */
export type UnloadedLane = Exclude<LoadedLane, {readonly _tag: "Loaded"}>;

/**
 * What one lane's archive attempt proved. The `Archived` arm is the only one on which a directory
 * moved; every other arm left the lane exactly where it was.
 */
export type ArchiveOutcome =
	| {
			readonly _tag: "Archived";
			readonly issue: number;
			readonly from: string;
			readonly to: string;
			readonly through: "current" | "candidate";
			readonly defects: ReadonlyArray<string>;
			/** The board's own `stateReason` for the closure, when it carried one. */
			readonly closedReason: string | null;
	  }
	/** The key names no issue: a chore lane, or an issue-kind name carrying no leading number. */
	| {readonly _tag: "NoIssue"; readonly kind: "Chore" | "Unnumbered"}
	/** The lane record is absent, unreadable, or not the shape — `loadLane`'s own answer. */
	| {readonly _tag: "Unloadable"; readonly loaded: UnloadedLane}
	| {readonly _tag: "WorkflowUnreadable"; readonly path: string; readonly reason: string}
	| {readonly _tag: "TemplateUnreadable"; readonly path: string; readonly reason: string}
	| {readonly _tag: "Unjudgeable"; readonly logPath: string; readonly reason: string}
	| {readonly _tag: "Replays"; readonly logPath: string}
	| {readonly _tag: "ClosureUnknown"; readonly issue: number; readonly reason: string}
	| {readonly _tag: "IssueOpen"; readonly issue: number}
	| {readonly _tag: "Unprobeable"; readonly destination: string; readonly reason: string}
	| {readonly _tag: "Occupied"; readonly destination: string}
	| {
			readonly _tag: "Unmoved";
			readonly from: string;
			readonly to: string;
			readonly reason: string;
	  }
	/** The move reported success and the destination does not read back — a human's to look at. */
	| {readonly _tag: "Unverified"; readonly from: string; readonly to: string};

/**
 * Judge one lane and move it if BOTH gates hold: its issue reads closed on the board AND its log
 * fails to replay under {@link judgeArchive}. Anything else answers without touching the directory.
 */
export const archiveLane = <R = never>(
	move: ArchiveMove<R>,
): Effect.Effect<ArchiveOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		if (move.issue._tag !== "Issue") return {_tag: "NoIssue", kind: move.issue._tag} as const;
		const issue = move.issue.number;

		const loaded = yield* loadLane(move.ref);
		if (loaded._tag !== "Loaded") return {_tag: "Unloadable", loaded} as const;

		const workflowPath = path.join(loaded.dir, "workflow.json");
		const laneText = yield* Effect.result(readFile(workflowPath));
		if (Result.isFailure(laneText)) {
			return {
				_tag: "WorkflowUnreadable",
				path: workflowPath,
				reason: laneText.failure.reason,
			} as const;
		}
		const templateTexts: string[] = [];
		for (const templatePath of move.templatePaths) {
			const template = yield* Effect.result(readFile(templatePath));
			if (Result.isFailure(template)) {
				return {
					_tag: "TemplateUnreadable",
					path: templatePath,
					reason: template.failure.reason,
				} as const;
			}
			templateTexts.push(template.success);
		}

		const judged = judgeArchive(templateTexts, laneText.success, loaded.lane, loaded.entries);
		if (judged._tag === "Unjudgeable") {
			return {_tag: "Unjudgeable", logPath: loaded.logPath, reason: judged.reason} as const;
		}
		if (judged._tag === "Replays") return {_tag: "Replays", logPath: loaded.logPath} as const;

		const closure = yield* move.closed(issue);
		if (closure._tag === "Unknown") {
			return {_tag: "ClosureUnknown", issue, reason: closure.reason} as const;
		}
		if (closure._tag === "Open") return {_tag: "IssueOpen", issue} as const;

		const destination = path.join(move.archivedRoot, move.ref.lane);
		const occupied = yield* Effect.result(exists(destination));
		if (Result.isFailure(occupied)) {
			return {_tag: "Unprobeable", destination, reason: occupied.failure.reason} as const;
		}
		if (occupied.success) return {_tag: "Occupied", destination} as const;

		const moved = yield* Effect.result(rename(loaded.dir, destination));
		if (Result.isFailure(moved)) {
			return {
				_tag: "Unmoved",
				from: loaded.dir,
				to: destination,
				reason: moved.failure.reason,
			} as const;
		}
		const landed = yield* Effect.result(exists(path.join(destination, "workflow.json")));
		if (Result.isFailure(landed) || !landed.success) {
			return {_tag: "Unverified", from: loaded.dir, to: destination} as const;
		}

		return {
			_tag: "Archived",
			issue,
			from: loaded.dir,
			to: destination,
			through: judged.through,
			defects: judged.defects,
			closedReason: closure.reason,
		} as const;
	});
