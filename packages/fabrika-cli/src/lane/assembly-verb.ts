/**
 * `lane assembly` — place, resume, or remove the worktree an epic run assembles in, and answer its
 * path.
 *
 * It is the only sanctioned way to reach `epic/<n>`'s working tree, because it is the only one that
 * cannot conscript the driver's checkout: `git worktree add` places the branch in a tree of its own
 * and leaves the invoking tree exactly where it was, where `git switch --create` moved it and kept
 * it there for the run (#6163). The branch name and the path are both derived from the epic number,
 * never taken from the caller, so "this is the run's assembly tree" is a fact rather than a claim
 * the argument asserts.
 *
 * Every mode reads the outcome back off `git worktree list` before answering. A `git worktree add`
 * that reported success and left no tree, or a `remove` that left one behind, is UNKNOWN and seats
 * on `8` — the same discipline `lane push` holds against a remote ref.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "../io/exec.ts";
import {localBranches} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {epicBranch} from "../wire/lane-brief.ts";
import {assemblySeat, worktrees} from "./assembly.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE, PRIMARY_CHECKOUT} from "./codes.ts";
import {loadRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane assembly";

export interface AssemblyOptions extends LaneRef {
	readonly epic: number;
	/** Remove the run's assembly worktree instead of placing it — the lane's terminal step. */
	readonly remove: boolean;
}

const seatOf = (epic: number, branch: string) =>
	Effect.gen(function* () {
		const listed = yield* worktrees;
		return listed._tag === "Failure"
			? ({_tag: "Unreadable", reason: listed.reason} as const)
			: ({_tag: "Read", seat: assemblySeat(listed.value, epic, branch)} as const);
	});

const conscripted = (branch: string, path: string): VerbOutcome =>
	refuse(
		PRIMARY_CHECKOUT,
		`${VERB}: ${branch} is checked out in the main working tree (${path}) — the assembly seat never conscripts it. Switch that tree off ${branch}, then run this verb again to place the run's own worktree.`,
	);

export const runAssembly = (
	options: AssemblyOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);

		const branch = epicBranch(options.epic);
		const before = yield* seatOf(options.epic, branch);
		if (before._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read this repository's working trees: ${before.reason} — whether ${branch} sits in the main checkout is UNKNOWN, so nothing was placed or removed.`,
			);
		}
		const seat = before.seat;

		if (options.remove) {
			if (seat._tag === "Conscripted") return conscripted(branch, seat.path);
			if (seat._tag === "Absent") {
				return answer(`${seat.expected}\n`, [
					`${VERB}: no worktree holds ${branch} — nothing to remove.`,
				]);
			}
			// Never `--force`: a dirty assembly tree is unlanded work, and git refusing to drop it is
			// the answer, not an obstacle.
			const removed = yield* execCapture("git", ["worktree", "remove", seat.path]);
			const after = yield* seatOf(options.epic, branch);
			if (after._tag === "Unreadable") {
				return refuse(
					APPEND_UNKNOWN,
					`${VERB}: ran the removal and cannot re-read the working trees: ${after.reason} — the outcome is UNKNOWN.`,
				);
			}
			if (after.seat._tag !== "Absent") {
				return refuse(
					APPEND_UNKNOWN,
					`${VERB}: ${seat.path} still holds ${branch} after the removal${removed.ok ? "" : `: ${removed.reason}`} — it was NOT removed.`,
				);
			}
			return answer(`${seat.path}\n`, [
				`${VERB}: removed the assembly worktree for #${options.epic}.`,
			]);
		}

		if (seat._tag === "Conscripted") return conscripted(branch, seat.path);
		if (seat._tag === "Isolated") {
			return answer(`${seat.path}\n`, [
				`${VERB}: resuming the assembly worktree of the lane at ${loaded.dir}.`,
			]);
		}

		const branches = yield* localBranches;
		if (branches._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read this repository's branches: ${branches.reason} — whether ${branch} already exists is UNKNOWN, so nothing was placed.`,
			);
		}
		// The branch outliving its worktree is the ordinary state after `--remove` at a terminal, a
		// pruned tree, or a crash mid-run — so it is resumed, checked out as it stands. Only a first
		// placement cuts, and only a cut needs a fresh base: `origin/HEAD` is git's own pointer at the
		// default branch, and `set-head` writes it in a checkout where it was never set.
		const resuming = branches.value.includes(branch);
		if (!resuming) {
			const fetched = yield* execCapture("git", ["fetch", "--quiet", "origin"]);
			if (!fetched.ok) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot fetch origin: ${fetched.reason} — the assembly branch is never cut off a stale base.`,
				);
			}
			yield* execCapture("git", ["remote", "set-head", "origin", "--auto"]);
		}
		const created = yield* execCapture(
			"git",
			resuming
				? ["worktree", "add", seat.expected, branch]
				: ["worktree", "add", "-b", branch, seat.expected, "origin/HEAD"],
		);
		const after = yield* seatOf(options.epic, branch);
		if (after._tag === "Unreadable") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: ran the placement and cannot re-read the working trees: ${after.reason} — the outcome is UNKNOWN.`,
			);
		}
		if (after.seat._tag === "Conscripted") return conscripted(branch, after.seat.path);
		if (after.seat._tag === "Absent") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: no worktree holds ${branch} after the placement${created.ok ? "" : `: ${created.reason}`} — it was NOT placed.`,
			);
		}
		return answer(`${after.seat.path}\n`, [
			`${VERB}: ${resuming ? "re-placed the worktree of the existing" : "placed"} ${branch} for the lane at ${loaded.dir}; the invoking checkout was not switched.`,
		]);
	});
