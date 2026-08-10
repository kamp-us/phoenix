/**
 * The four git reads this group needs beyond `../io/git.ts`'s — presence in a tree, and history over
 * a path.
 *
 * **Presence is probed with a pathspec, never with a read that fails on absence.** `git ls-tree
 * --name-only <sha> -- <path>` exits `0` whether or not the path is there and prints it only when it
 * is, so "not in the tree" is a *fact* and a non-zero exit is a *failed read*. That split is what
 * lets `pattern corpus` answer `absent` at exit `0` while still refusing `11` on a read it could not
 * perform — the two would be one answer if absence were inferred from a failure.
 */
import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";

/** One commit, as this group reports it: the full object name and the author date. */
export interface Commit {
	readonly sha: string;
	/** The author date as `YYYY-MM-DD`. */
	readonly date: string;
}

const parseCommits = (stdout: string): ReadonlyArray<Commit> =>
	stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.flatMap((line) => {
			const [sha, date] = line.split("\t");
			return sha === undefined || date === undefined ? [] : [{sha, date}];
		});

/** The subset of `paths` present in the tree at `sha`. An empty input spawns nothing. */
export const presentPathsAt = (
	sha: string,
	paths: ReadonlyArray<string>,
): Shell<Attempt<ReadonlySet<string>>> =>
	Effect.gen(function* () {
		if (paths.length === 0) return ok<ReadonlySet<string>>(new Set());
		const r = yield* execCapture("git", ["ls-tree", "--name-only", sha, "--", ...paths]);
		if (!r.ok) return fail(r.reason);
		return ok<ReadonlySet<string>>(
			new Set(
				r.stdout
					.split("\n")
					.map((p) => p.trim())
					.filter((p) => p !== ""),
			),
		);
	});

/** Whether one path is present in the tree at `sha`. */
export const pathPresentAt = (sha: string, path: string): Shell<Attempt<boolean>> =>
	Effect.gen(function* () {
		const present = yield* presentPathsAt(sha, [path]);
		return present._tag === "Failure" ? present : ok(present.value.has(path));
	});

/** The top-level entries of the tree at `sha` — the segment set a cited path must open with. */
export const topLevelEntriesAt = (sha: string): Shell<Attempt<ReadonlySet<string>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["ls-tree", "--name-only", `${sha}:`]);
		if (!r.ok) return fail(r.reason);
		return ok<ReadonlySet<string>>(
			new Set(
				r.stdout
					.split("\n")
					.map((p) => p.trim())
					.filter((p) => p !== ""),
			),
		);
	});

/** The last commit touching `path` at or before `sha`, or `null` when none does. */
export const lastCommitTouching = (sha: string, path: string): Shell<Attempt<Commit | null>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["log", "-1", "--format=%H%x09%as", sha, "--", path]);
		if (!r.ok) return fail(r.reason);
		return ok(parseCommits(r.stdout)[0] ?? null);
	});

/** Every commit touching `path` in the range *(anchor, base]*, newest first. */
export const commitsTouchingRange = (
	anchor: string,
	base: string,
	path: string,
): Shell<Attempt<ReadonlyArray<Commit>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", [
			"log",
			"--format=%H%x09%as",
			`${anchor}..${base}`,
			"--",
			path,
		]);
		return r.ok ? ok(parseCommits(r.stdout)) : fail(r.reason);
	});
