/**
 * The keep rule `lane cleanup` turns on: may this recorded worktree be taken off disk?
 *
 * Pure, and apart from the verb because the whole rule lives here. A tree goes only when every read
 * of it answered and none found something a removal would lose. Four things hold a tree: a path
 * git calls uncommitted, a commit that is neither reachable from a remote ref nor carried by one of
 * the lane's merged pull requests, a builder whose in-flight seat still stands on it, and a
 * directory that still stands where git holds no live registration. A read that failed holds it too,
 * because a tree nobody could read is a tree nobody proved empty.
 *
 * A local branch does not count as a home for a commit. The removal would leave the branch, so the
 * commit would survive it, but a branch only this clone holds is still work that exists nowhere
 * else, and the lane is ending.
 *
 * Three trees are never judged at all: the main working tree, which is no lane's to remove, the
 * tree the verb runs in, which no process can remove from inside, and a tree a driver recorded. A
 * driver outlives every shell it spawns, the shipper that runs this verb included, and nothing on
 * this machine says its shell has returned, so its tree is its own caller's to remove.
 *
 * Git's `prunable` flag is read off a tree's `.git` file, never its directory, so it does not say
 * the directory is gone. Only a probe of the path does.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10340
 */
import type {WorkingTrees} from "./assembly.ts";
import type {LogEntry} from "./fold.ts";

/** Where a tree's commits live, judged against the remote and the lane's merged pull requests. */
export type Commits =
	/** Every commit `HEAD` reaches is reachable from a remote ref. */
	| {readonly _tag: "Published"}
	/** Some commits are on no remote ref, and merged pull request `pull` carries all of them. */
	| {readonly _tag: "Merged"; readonly pull: number}
	/** `count` commits are on no remote ref and no merged pull request of the lane carries them. */
	| {readonly _tag: "LocalOnly"; readonly count: number; readonly why: string};

export type TreeState =
	/** No directory stands at the path, and git holds no live registration for it. */
	| {readonly _tag: "Gone"}
	/** A directory stands at the path and git holds no live registration for it. */
	| {readonly _tag: "Stranded"; readonly prunable: boolean}
	| {readonly _tag: "Main"}
	| {readonly _tag: "Caller"}
	/** A driver recorded this tree and is not the one running the verb. */
	| {readonly _tag: "Driver"}
	/** A builder's in-flight seat still names this tree. */
	| {readonly _tag: "InFlight"}
	| {readonly _tag: "Unreadable"; readonly reason: string}
	| {readonly _tag: "Read"; readonly uncommitted: number; readonly commits: Commits};

export type KeptReason =
	| "uncommitted"
	| "unpublished"
	| "in-flight"
	| "unregistered"
	| "unreadable"
	/** git declined the plain removal; its own reason is the detail. */
	| "remove-refused";

export type Disposition =
	| {readonly _tag: "Remove"}
	| {readonly _tag: "Gone"}
	/** Not the lane's to remove from here, and no fault: it changes no exit code. */
	| {readonly _tag: "Left"; readonly reason: "caller" | "main-working-tree" | "driver"}
	| {readonly _tag: "Kept"; readonly reason: KeptReason; readonly detail: string};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

export const dispose = (state: TreeState): Disposition => {
	switch (state._tag) {
		case "Gone":
			return {_tag: "Gone"};
		case "Main":
			return {_tag: "Left", reason: "main-working-tree"};
		case "Caller":
			return {_tag: "Left", reason: "caller"};
		case "Driver":
			return {_tag: "Left", reason: "driver"};
		case "Stranded":
			return {
				_tag: "Kept",
				reason: "unregistered",
				detail: state.prunable
					? "git marks its registration prunable and the directory still stands"
					: "git lists no working tree there and the directory still stands",
			};
		case "InFlight":
			return {
				_tag: "Kept",
				reason: "in-flight",
				detail: "a builder's in-flight record still stands on it, so its shell has not returned",
			};
		case "Unreadable":
			return {_tag: "Kept", reason: "unreadable", detail: state.reason};
		case "Read": {
			if (state.uncommitted > 0) {
				return {
					_tag: "Kept",
					reason: "uncommitted",
					detail: plural(state.uncommitted, "uncommitted path"),
				};
			}
			if (state.commits._tag === "LocalOnly") {
				return {
					_tag: "Kept",
					reason: "unpublished",
					detail: `${plural(state.commits.count, "commit")} on no remote ref — ${state.commits.why}`,
				};
			}
			return {_tag: "Remove"};
		}
	}
};

/** Where a recorded path sits among this clone's working trees, before any read inside it. */
export type Seat =
	/** Git holds no live registration; whether the directory stands is the verb's probe to make. */
	| {readonly _tag: "Unregistered"; readonly prunable: boolean}
	| {readonly _tag: "Main"}
	| {readonly _tag: "Caller"}
	| {readonly _tag: "Driver"}
	| {readonly _tag: "InFlight"}
	/** A live linked worktree; `path` is the spelling git lists it under. */
	| {readonly _tag: "Linked"; readonly path: string};

/**
 * Seat one recorded path. Every path handed in is already resolved the same way, so two spellings
 * of one directory compare equal.
 *
 * The main tree is tested first: it outranks every other answer, the caller's included. `task` is
 * the one the tree was recorded under, and `null` is how a driver records its own.
 */
export const seatOf = (
	worktree: string,
	task: string | null,
	trees: WorkingTrees,
	caller: string,
	working: ReadonlySet<string>,
): Seat => {
	if (worktree === trees.main.path) return {_tag: "Main"};
	const entry = trees.linked.find((linked) => linked.path === worktree);
	if (entry === undefined || entry.prunable) {
		return {_tag: "Unregistered", prunable: entry !== undefined};
	}
	if (worktree === caller) return {_tag: "Caller"};
	if (task === null) return {_tag: "Driver"};
	if (working.has(worktree)) return {_tag: "InFlight"};
	return {_tag: "Linked", path: entry.path};
};

const PULL_URL = /\/pull\/(\d+)\/?(?:[?#].*)?$/;

/** The pull requests the lane's own log names, oldest first, each once. */
export const lanePulls = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<number> => [
	...new Set(
		entries.flatMap((entry) => {
			const number = Number(PULL_URL.exec(entry.pr ?? "")?.[1] ?? "");
			return Number.isInteger(number) && number > 0 ? [number] : [];
		}),
	),
];
