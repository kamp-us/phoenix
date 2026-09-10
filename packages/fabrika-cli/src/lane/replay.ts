/**
 * The replay leg — put a colliding child's commits back down on the assembly tip instead of stopping.
 *
 * Two reviewed children that each append a row to one registry file collide at `lane integrate`, and
 * before this leg the whole answer was the aborted merge: the later child was sent back to a fresh
 * build, which re-implements work a reviewer already graded. The replay is the repair that was
 * missing — the child's own commits, replayed one at a time onto the tip, with the plain keep-both
 * hunks resolved by keeping both.
 *
 * What it does not do is resolve a semantic conflict: {@link resolveKeepBoth} is the whole content
 * judgment, and a hunk it refuses ends the replay with the seat put back where it started.
 *
 * The replay lands on its own branch and that branch is merged `--no-ff`, exactly as the plain path
 * merges the child: the assembly branch keeps one commit per landing either way, so the epic
 * reviewer reads the same history shape whichever path a child took.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "../io/exec.ts";
import {readFile, writeFile} from "../io/fs.ts";
import {type KeepBoth, resolveKeepBoth} from "./keep-both.ts";

/** The cause a replay that is not a plain keep-both parks under — `lane report --cause`'s closed set. */
export const REPLAY_PARK_CAUSE = "replay-conflict";

export interface ReplayOptions {
	/** The assembly seat: a working tree standing on the assembly branch, at the tip, clean. */
	readonly path: string;
	/** The assembly branch the seat stands on, returned to before this leg answers. */
	readonly branch: string;
	/** The child's branch, whose commits are replayed. */
	readonly child: string;
	/** The assembly tip the child is replayed onto — the head captured before the merge. */
	readonly tip: string;
}

/** What the replay moved: the child's range, as it now stands on the assembly branch. */
export interface MovedRange {
	readonly from: string;
	readonly to: string;
}

export type ReplayOutcome =
	| {
			readonly _tag: "Replayed";
			readonly replayBranch: string;
			readonly range: MovedRange;
			readonly commits: number;
			/** The paths whose conflict was resolved by keeping both sides. */
			readonly resolved: ReadonlyArray<string>;
	  }
	/** A hunk no keep-both reaches. The seat is back on its branch; the caller proves the reset. */
	| {readonly _tag: "NotKeepBoth"; readonly reason: string; readonly paths: ReadonlyArray<string>}
	/** Something on the path could not be read or run — UNKNOWN, never a clean refusal. */
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * The branch a replay lands on, derived from the child and the tip it was replayed onto.
 *
 * Both operands are in the name because both decide what the branch holds: a second replay of the
 * same child onto the same tip recomputes the same commits, and one onto a moved tip is a different
 * range that must not overwrite the first. The child's branch is carried whole rather than mined for
 * its number — a name parsed out of another name is a guess, and this one only has to be unique and
 * derivable.
 */
export const replayBranchName = (child: string, tip: string): string =>
	`replay/${child.replaceAll("/", "-")}-onto-${tip.slice(0, 7)}`;

type Shell<A> = Effect.Effect<A, never, ChildProcessSpawner.ChildProcessSpawner>;

const git = (path: string, ...args: ReadonlyArray<string>) =>
	execCapture("git", ["-C", path, ...args]);

/** The paths git reports unmerged after a pick stopped — the only paths this leg may write. */
const unmergedPaths = (path: string): Shell<ReadonlyArray<string> | null> =>
	Effect.map(git(path, "diff", "--name-only", "--diff-filter=U"), (read) =>
		read.ok ? read.stdout.split("\n").filter((line) => line.trim() !== "") : null,
	);

type Resolution =
	| {readonly _tag: "Resolved"; readonly paths: ReadonlyArray<string>}
	| {readonly _tag: "NotKeepBoth"; readonly reason: string; readonly paths: ReadonlyArray<string>}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * Resolve every unmerged path by keeping both sides, or refuse the whole pick.
 *
 * The refusal is whole rather than per file on purpose: a half-resolved pick is a tree carrying one
 * file's automatic answer and another file's markers, and there is no state a caller could record
 * about it.
 */
const resolveAll = (
	path: string,
	paths: ReadonlyArray<string>,
): Effect.Effect<
	Resolution,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const written: Array<string> = [];
		for (const file of paths) {
			const full = `${path}/${file}`;
			const read = yield* Effect.result(readFile(full));
			if (Result.isFailure(read)) {
				return {
					_tag: "Unreadable" as const,
					reason: `cannot read the conflicted ${file}: ${read.failure.reason}`,
				};
			}
			const judged: KeepBoth = resolveKeepBoth(read.success);
			if (judged._tag === "NotKeepBoth") {
				return {_tag: "NotKeepBoth" as const, reason: `${file}: ${judged.reason}`, paths};
			}
			const wrote = yield* Effect.result(writeFile(full, judged.text));
			if (Result.isFailure(wrote)) {
				return {
					_tag: "Unreadable" as const,
					reason: `cannot write the resolved ${file}: ${wrote.failure.reason}`,
				};
			}
			const staged = yield* git(path, "add", "--", file);
			if (!staged.ok) {
				return {
					_tag: "Unreadable" as const,
					reason: `cannot stage the resolved ${file}: ${staged.reason}`,
				};
			}
			written.push(file);
		}
		return {_tag: "Resolved" as const, paths: written};
	});

/** The two arms a stopped replay can end on, before the seat is put back on its branch. */
type Refusal = Extract<ReplayOutcome, {readonly _tag: "NotKeepBoth" | "Unreadable"}>;

/**
 * Abandon the pick, put the seat back on its branch, and answer the refusal that got us here.
 *
 * A refusal whose own put-back failed is UNKNOWN whatever it was going to be: the caller's restore
 * describes a branch, and a detached seat is not one.
 *
 * The abort's own exit is read rather than discarded, because a checkout succeeds while a pick is
 * still in progress — the refusal would come back clean over a seat whose next pick refuses, and
 * the caller's `restore()` neither removes the in-progress pick nor sees it, since a hard reset
 * leaves `CHERRY_PICK_HEAD` alone and the proof only re-reads HEAD. A failed abort is not itself the
 * defect, though: a pick that never started (a bad object, an unreadable commit) leaves nothing to
 * abort and fails saying so, so the seat is asked directly whether the pick survived.
 */
const leave = (options: ReplayOptions, outcome: Refusal): Shell<ReplayOutcome> =>
	Effect.gen(function* () {
		const aborted = yield* git(options.path, "cherry-pick", "--abort");
		if (!aborted.ok) {
			const surviving = yield* git(
				options.path,
				"rev-parse",
				"--verify",
				"--quiet",
				"CHERRY_PICK_HEAD",
			);
			if (surviving.ok) {
				return {
					_tag: "Unreadable" as const,
					reason: `${outcome.reason} — and the pick would not abort: ${aborted.reason}, so ${options.path} still carries one at ${surviving.stdout.trim()} and what a reset would leave there is UNKNOWN`,
				};
			}
		}
		const back = yield* git(options.path, "checkout", options.branch);
		return back.ok
			? outcome
			: {
					_tag: "Unreadable" as const,
					reason: `${outcome.reason} — and ${options.path} cannot be put back on ${options.branch}: ${back.reason}, so the seat is detached and what it carries is UNKNOWN`,
				};
	});

/**
 * Replay the child's commits onto the tip, and merge the result into the assembly branch.
 *
 * The seat detaches at the tip for the picks and is put back on its branch before this answers, on
 * every arm including the refusals — a leg that left the seat detached would hand the caller a tree
 * its own restore could not describe.
 */
export const replayChild = (
	options: ReplayOptions,
): Effect.Effect<
	ReplayOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {path, branch, child, tip} = options;

		const listed = yield* git(path, "rev-list", "--reverse", `${tip}..${child}`);
		if (!listed.ok) {
			return {
				_tag: "Unreadable" as const,
				reason: `cannot list the commits ${child} adds over ${tip}: ${listed.reason}`,
			};
		}
		const commits = listed.stdout.split("\n").filter((line) => line.trim() !== "");
		if (commits.length === 0) {
			return {
				_tag: "Unreadable" as const,
				reason: `${child} adds no commit over ${tip}, yet the merge conflicted — what the two branches disagree about is UNKNOWN`,
			};
		}

		const detached = yield* git(path, "checkout", "--detach", tip);
		if (!detached.ok) {
			return {
				_tag: "Unreadable" as const,
				reason: `cannot detach ${path} at ${tip}: ${detached.reason}`,
			};
		}

		// A path that conflicts on two of the child's commits is one path kept both ways, not two: the
		// set is what keeps the note's count and the event's `resolved` field naming files rather than
		// collisions.
		const resolved = new Set<string>();
		for (const commit of commits) {
			const picked = yield* git(
				path,
				"-c",
				"merge.conflictStyle=diff3",
				"cherry-pick",
				"--allow-empty",
				commit,
			);
			if (picked.ok) continue;

			const unmerged = yield* unmergedPaths(path);
			if (unmerged === null) {
				return yield* leave(options, {
					_tag: "Unreadable",
					reason: `${commit} did not replay and which paths are unmerged cannot be read: ${picked.reason}`,
				});
			}
			if (unmerged.length === 0) {
				return yield* leave(options, {
					_tag: "NotKeepBoth",
					reason: `${commit} did not replay and no path is unmerged: ${picked.reason}`,
					paths: [],
				});
			}
			const answered = yield* resolveAll(path, unmerged);
			if (answered._tag !== "Resolved") return yield* leave(options, answered);
			for (const file of answered.paths) resolved.add(file);

			const continued = yield* git(path, "-c", "core.editor=true", "cherry-pick", "--continue");
			if (!continued.ok) {
				return yield* leave(options, {
					_tag: "Unreadable",
					reason: `${commit}'s conflicts were kept both ways and the pick would not continue: ${continued.reason}`,
				});
			}
		}

		const replayed = yield* git(path, "rev-parse", "HEAD");
		if (!replayed.ok) {
			return yield* leave(options, {
				_tag: "Unreadable",
				reason: `the replay landed and its head cannot be read: ${replayed.reason}`,
			});
		}
		const head = replayed.stdout.trim();

		// `--force` only ever overwrites a prior replay of this same child onto this same tip, which is
		// the range this run just recomputed; a moved tip is a different name.
		const replayBranch = replayBranchName(child, tip);
		const named = yield* git(path, "branch", "--force", replayBranch, head);
		if (!named.ok) {
			return yield* leave(options, {
				_tag: "Unreadable",
				reason: `cannot name the replayed range ${replayBranch}: ${named.reason}`,
			});
		}

		const back = yield* git(path, "checkout", branch);
		if (!back.ok) {
			return {
				_tag: "Unreadable" as const,
				reason: `the replay landed at ${head} and ${path} cannot be put back on ${branch}: ${back.reason} — the seat is detached and what it carries is UNKNOWN`,
			};
		}
		const merged = yield* git(path, "merge", "--no-ff", "--no-edit", replayBranch);
		if (!merged.ok) {
			yield* git(path, "merge", "--abort");
			return {
				_tag: "Unreadable" as const,
				reason: `${replayBranch} was replayed onto ${tip} and still conflicts with ${branch}: ${merged.reason} — a range built on this tip cannot conflict with it, so the seat's state is UNKNOWN`,
			};
		}

		return {
			_tag: "Replayed" as const,
			replayBranch,
			range: {from: tip, to: head},
			commits: commits.length,
			resolved: [...resolved],
		};
	});
