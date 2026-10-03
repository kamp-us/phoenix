/**
 * `lane worktree` — record the tree a shell of this lane runs in ([`worktrees.ts`](worktrees.ts)).
 *
 * Every shell runs it once, first thing, from inside its own worktree. The path is read off git
 * rather than passed, so it names the tree the shell stands in. It appends a record, never an event,
 * so the fold cannot be moved by it.
 *
 * The main working tree is answered and never recorded: it is no lane's to remove, so a record
 * naming it would be a tree `lane cleanup` has to refuse on every run.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10340
 */
import {Effect, FileSystem, Path, Result} from "effect";
import {appendText} from "../io/fs.ts";
import type {Attempt} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {instant} from "../wire/lane-record.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {
	APPEND_UNKNOWN,
	CONCURRENT_WRITE,
	FACT_REFUSED,
	LANE_UNREADABLE,
	MALFORMED_RECORD,
	TASK_UNKNOWN,
} from "./codes.ts";
import {loadRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";
import {encodeWorktree, handedTrees, loadWorktrees} from "./worktrees.ts";

const VERB = "fabrika lane worktree";

/**
 * Append a `handed` record for `worktree` under the ledger lock.
 *
 * A tree the lane already holds is answered without a second line, so a shell that runs this twice
 * leaves one record. `verb` labels the refusals, because `lane dispatch` records its own tree here.
 */
export const handTree = (
	verb: string,
	ref: LaneRef,
	task: string | null,
	worktree: string,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		if (!path.isAbsolute(worktree)) {
			return refuse(
				FACT_REFUSED,
				`${verb}: the tree "${worktree}" is not an absolute path. Nothing was appended.`,
			);
		}
		return yield* withLedgerLock(
			{fs, path, dir: path.join(ref.root, ref.lane), verb},
			Effect.gen(function* () {
				const loaded = yield* loadLane(ref);
				if (loaded._tag !== "Loaded") return loadRefusal(verb, loaded);
				if (task !== null && loaded.lane.tasks[task] === undefined) {
					return refuse(
						TASK_UNKNOWN,
						`${verb}: task "${task}" is not in this lane's machine (tasks: ${Object.keys(loaded.lane.tasks).join(", ")}). Nothing was appended.`,
					);
				}
				const standing = yield* loadWorktrees(loaded.dir);
				if (standing._tag === "Unreadable") {
					return refuse(
						LANE_UNREADABLE,
						`${verb}: cannot read ${standing.path}: ${standing.reason} — nothing was appended.`,
					);
				}
				if (standing._tag === "Malformed") {
					return refuse(
						MALFORMED_RECORD,
						`${verb}: ${standing.path} was read in full and is not the shape — nothing was appended.`,
						standing.defects.map((defect) => `${verb}: defect: ${defect}`),
					);
				}
				const told = (recorded: boolean): VerbOutcome =>
					answer(JSON.stringify({answer: "handed", lane: ref.lane, task, worktree, recorded}), [
						recorded
							? `${verb}: lane ${ref.lane} now holds ${worktree}.`
							: `${verb}: lane ${ref.lane} already holds ${worktree} — nothing was appended.`,
					]);
				if (handedTrees(standing.records).some((tree) => tree.worktree === worktree)) {
					return told(false);
				}
				const at = instant(yield* Effect.sync(() => new Date().toISOString()));
				if (at === null) {
					return refuse(FACT_REFUSED, `${verb}: the clock gave no instant — nothing was appended.`);
				}
				const wrote = yield* Effect.result(
					appendText(standing.path, encodeWorktree({kind: "handed", worktree, task, at})),
				);
				if (Result.isFailure(wrote)) {
					return refuse(
						APPEND_UNKNOWN,
						`${verb}: the append to ${standing.path} did not land: ${wrote.failure.reason} — the tree is NOT recorded.`,
					);
				}
				return told(true);
			}),
			{
				onAbsent: (absentDir) => loadRefusal(verb, {_tag: "Absent", dir: absentDir}),
				onLocked: (lockDir) => refuse(CONCURRENT_WRITE, lockedRefusal(verb, lockDir)),
			},
		);
	});

export interface WorktreeOptions extends LaneRef {
	readonly task: string | null;
	/** The tree this process runs in, read off git by the adapter. */
	readonly worktree: Attempt<string>;
	/** Whether that tree is a linked worktree rather than the main working tree. */
	readonly linked: Attempt<boolean>;
}

/** Record the tree this shell runs in on the lane it serves. */
export const runWorktree = (
	options: WorktreeOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (options.worktree._tag === "Failure" || options.linked._tag === "Failure") {
			const reason =
				options.worktree._tag === "Failure"
					? options.worktree.reason
					: options.linked._tag === "Failure"
						? options.linked.reason
						: "";
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read which tree this runs in: ${reason} — nothing was appended.`,
			);
		}
		const worktree = options.worktree.value;
		if (!options.linked.value) {
			return answer(
				JSON.stringify({
					answer: "main",
					lane: options.lane,
					task: options.task,
					worktree,
					recorded: false,
				}),
				[
					`${VERB}: ${worktree} is the main working tree, which no lane removes — nothing was appended.`,
				],
			);
		}
		return yield* handTree(VERB, options, options.task, worktree);
	});
