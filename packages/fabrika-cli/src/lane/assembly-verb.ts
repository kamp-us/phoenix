/**
 * `lane assembly` — place, resume, or remove the worktree an epic run assembles in, and answer its
 * path.
 *
 * It is the only sanctioned way to reach `epic/<n>`'s working tree, because it is the only one that
 * cannot conscript the driver's checkout: `git worktree add` places the branch in a tree of its own
 * and leaves the invoking tree exactly where it was, where `git switch --create` moved it and kept
 * it there for the run. The branch name and the path are both derived from the epic number,
 * never taken from the caller, so "this is the run's assembly tree" is a fact rather than a claim
 * the argument asserts.
 *
 * Every mode reads the outcome back off `git worktree list` before answering. A `git worktree add`
 * that reported success and left no tree, or a `remove` that left one behind, is UNKNOWN and seats
 * on `8` — the same discipline `lane push` holds against a remote ref.
 *
 * A resume asks one more question than "does the branch exist": whether `origin/HEAD` already
 * contains its head. A multi-phase epic that ships an intermediate tail lands in exactly that state,
 * and the branch is then simultaneously the sanctioned base for every remaining child and guaranteed
 * to conflict with the trunk. Containment is the one proof that re-cutting loses nothing, so it is
 * what opens that arm and nothing weaker does.
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
				seat._tag === "Stale"
					? `${VERB}: the assembly worktree for #${options.epic} was already gone; cleared the record git still held for it.`
					: `${VERB}: removed the assembly worktree for #${options.epic}.`,
			]);
		}

		if (seat._tag === "Conscripted") return conscripted(branch, seat.path);

		const branches = yield* localBranches;
		if (branches._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read this repository's branches: ${branches.reason} — whether ${branch} already exists is UNKNOWN, so nothing was placed.`,
			);
		}
		const existing = branches.value.includes(branch);

		// Both arms need a fresh `origin/HEAD` — git's own pointer at the default branch, which
		// `set-head` writes in a checkout where it was never set. A cut is never taken off a stale
		// base, and a containment answer computed against one would call a live branch landed.
		const fetched = yield* execCapture("git", ["fetch", "--quiet", "origin"]);
		if (!fetched.ok) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot fetch origin: ${fetched.reason} — the assembly branch is never cut off a stale base, nor judged landed against one.`,
			);
		}
		yield* execCapture("git", ["remote", "set-head", "origin", "--auto"]);

		// The branch outliving its worktree is the ordinary state after `--remove` at a terminal, a
		// pruned tree, or a crash mid-run — so it is resumed, checked out as it stands. The one
		// exception is a branch `origin/HEAD` already contains: its content landed, it holds nothing
		// the trunk lacks, and every child cut from it conflicts with what the trunk took since. That
		// containment is the whole warrant for re-cutting, so an unreadable answer refuses instead.
		let landed = false;
		if (existing) {
			const trunk = yield* execCapture("git", ["rev-parse", "--verify", "origin/HEAD^{commit}"]);
			if (!trunk.ok) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: origin was fetched and origin/HEAD names no commit: ${trunk.reason} — whether ${branch} is already contained in the default branch is UNKNOWN, so nothing was placed.`,
				);
			}
			const contained = yield* execCapture("git", [
				"merge-base",
				"--is-ancestor",
				branch,
				trunk.stdout.trim(),
			]);
			landed = contained.ok;
		}

		if (seat._tag === "Isolated" && !landed) {
			return answer(`${seat.path}\n`, [
				`${VERB}: resuming the assembly worktree of the lane at ${loaded.dir}.`,
			]);
		}
		if (seat._tag !== "Absent") {
			// A `Stale` record's directory is gone, and git refuses to add over the registration
			// ("missing but already registered worktree"); a landed `Isolated` seat stands on a branch
			// the placement below re-cuts. Both have to go first, and neither goes by `--force`: git
			// refusing to drop a dirty tree is what keeps uncommitted work out of a re-cut.
			const cleared = yield* execCapture("git", ["worktree", "remove", seat.path]);
			const recheck = yield* seatOf(options.epic, branch);
			if (recheck._tag === "Unreadable") {
				return refuse(
					APPEND_UNKNOWN,
					`${VERB}: cleared the worktree at ${seat.path} and cannot re-read the working trees: ${recheck.reason} — the outcome is UNKNOWN.`,
				);
			}
			if (recheck.seat._tag !== "Absent") {
				return refuse(
					APPEND_UNKNOWN,
					`${VERB}: git still carries ${branch} at ${seat.path}${cleared.ok ? "" : `: ${cleared.reason}`} — nothing was placed, because a placement over a registration or a tree that survives is refused.`,
				);
			}
		}

		// `-B` re-points the landed branch at the fresh trunk in the same operation that places the
		// tree, so there is no window where the branch is deleted and the placement has yet to run.
		const created = yield* execCapture(
			"git",
			existing && !landed
				? ["worktree", "add", seat.expected, branch]
				: [
						"worktree",
						"add",
						"--no-track",
						existing ? "-B" : "-b",
						branch,
						seat.expected,
						"origin/HEAD",
					],
		);
		// A branch cut off `origin/HEAD` without `--no-track` records `refs/heads/main` as its
		// upstream, which aimed the run's pushes at the default branch. `--no-track` covers a fresh
		// cut and nothing else: measured on git 2.40.1, `worktree add --no-track -B` leaves a
		// pre-existing `branch.<name>.remote`/`.merge` in place, so a branch cut by an older fabrika
		// carries the config through a re-cut exactly as it does through a plain resume. Both arms are
		// cleared here. There is nothing to unset on a branch that tracks nothing, hence the ignored
		// result.
		if (existing) yield* execCapture("git", ["branch", "--unset-upstream", branch]);
		const after = yield* seatOf(options.epic, branch);
		if (after._tag === "Unreadable") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: ran the placement and cannot re-read the working trees: ${after.reason} — the outcome is UNKNOWN.`,
			);
		}
		if (after.seat._tag === "Conscripted") return conscripted(branch, after.seat.path);
		if (after.seat._tag !== "Isolated") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: no working tree holds ${branch} after the placement${created.ok ? "" : `: ${created.reason}`} — it was NOT placed.`,
			);
		}
		return answer(`${after.seat.path}\n`, [
			landed
				? `${VERB}: re-cut ${branch} off origin/HEAD for the lane at ${loaded.dir} — its head was already contained in the default branch, so it carried no unlanded work and every child cut from it would have conflicted with what the trunk took since; the invoking checkout was not switched.`
				: `${VERB}: ${existing ? "re-placed the worktree of the existing" : "placed"} ${branch} for the lane at ${loaded.dir}; the invoking checkout was not switched.`,
		]);
	});
