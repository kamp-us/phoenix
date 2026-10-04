/**
 * `lane leave` — remove the worktree this shell stands in, as the shell's last act.
 *
 * It is for a shell no lane cleans up after: one that serves no lane, and a lane's own driver,
 * whose tree `lane cleanup` leaves. The keep rule is [`cleanup.ts`](cleanup.ts)'s `dispose` over the
 * same read `lane cleanup` makes of a tree, so there is one rule and this verb adds no arm to it.
 *
 * A process can remove the tree it stands in because the removal is git's, run as a child addressed
 * at the main working tree with `-C`. Git changes into that directory before it reads anything, so
 * no step of the removal resolves this process's own directory. The re-read after it is addressed
 * the same way, because by then this process stands in a directory that is gone.
 *
 * There is no `--force` anywhere in this file.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10389
 */
import {Effect, FileSystem, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "../io/exec.ts";
import {exists} from "../io/fs.ts";
import type {Attempt} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {parseWorktreeList, splitTrees, type WorkingTrees, worktrees} from "./assembly.ts";
import {type Disposition, dispose, type TreeState} from "./cleanup.ts";
import {readTree} from "./cleanup-verb.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE, TREES_KEPT} from "./codes.ts";

const VERB = "fabrika lane leave";

export interface LeaveOptions {
	/** The tree this process runs in, read off git by the adapter. */
	readonly tree: Attempt<string>;
}

type Services = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem;

const kept = (worktree: string, {reason, detail}: Extract<Disposition, {_tag: "Kept"}>) =>
	refuse(
		TREES_KEPT,
		`${VERB}: kept ${worktree} — ${reason}: ${detail}. Nothing was forced; repeat this path and reason in your closing message.`,
	);

export const runLeave = (options: LeaveOptions): Effect.Effect<VerbOutcome, never, Services> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		if (options.tree._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read which tree this runs in: ${options.tree.reason} — nothing was removed.`,
			);
		}
		const worktree = options.tree.value;
		const listed = yield* worktrees;
		if (listed._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read this repository's working trees: ${listed.reason} — nothing was removed.`,
			);
		}

		// Git's own list and `rev-parse` disagree on a symlinked prefix, so both sides are resolved
		// before they are compared. A path that resolves nowhere keeps its spelling.
		const real = (raw: string) =>
			Effect.map(Effect.result(fs.realPath(raw)), (resolved) =>
				Result.isSuccess(resolved) ? resolved.success : raw,
			);
		const seated = (trees: WorkingTrees, at: string) =>
			Effect.gen(function* () {
				for (const entry of trees.linked) {
					if ((yield* real(entry.path)) === at) return entry;
				}
				return null;
			});
		const here = yield* real(worktree);
		const main = listed.value.main.path;
		if ((yield* real(main)) === here) {
			return answer(JSON.stringify({answer: "main", worktree}), [
				`${VERB}: ${worktree} is the main working tree, which no shell removes — nothing was touched.`,
			]);
		}

		const entry = yield* seated(listed.value, here);
		const state: TreeState =
			entry === null || entry.prunable
				? {_tag: "Stranded", prunable: entry !== null}
				: yield* readTree(worktree, (_head, count) =>
						Effect.succeed({
							_tag: "LocalOnly",
							count,
							why: "no lane names a merged pull request that could carry them",
						} as const),
					);
		const disposition = dispose(state);
		if (disposition._tag === "Kept") return kept(worktree, disposition);
		if (disposition._tag !== "Remove" || entry === null) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: ${worktree} read as neither removable nor kept — nothing was removed.`,
			);
		}

		const removed = yield* execCapture("git", ["-C", main, "worktree", "remove", entry.path]);
		const relisted = yield* execCapture("git", ["-C", main, "worktree", "list", "--porcelain"]);
		const after = relisted.ok ? splitTrees(parseWorktreeList(relisted.stdout)) : null;
		const stands = yield* Effect.result(exists(worktree));
		if (after === null || Result.isFailure(stands)) {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: ran the removal of ${worktree} and cannot re-read ${after === null ? "the working trees" : "its directory"} — whether it landed is UNKNOWN.`,
			);
		}
		const live = yield* seated(after, here);
		if ((live !== null && !live.prunable) || stands.success) {
			return kept(worktree, {
				_tag: "Kept",
				reason: "remove-refused",
				detail: removed.ok ? "git reported success and the tree still stands" : removed.reason,
			});
		}
		return answer(JSON.stringify({answer: "removed", worktree}), [
			`${VERB}: removed ${worktree}. This was the tree you stand in, so run no further command from it.`,
		]);
	});
