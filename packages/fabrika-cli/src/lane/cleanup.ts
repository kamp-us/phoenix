/**
 * The keep rule `lane cleanup` turns on: may this recorded worktree be taken off disk?
 *
 * Pure, and apart from the verb because the whole rule lives here. A tree goes only when every read
 * of it answered and none found something a removal would lose. Four things hold a tree: a path
 * git calls uncommitted, a commit that is neither reachable from a remote ref nor carried by one of
 * the lane's merged pull requests, a shell still in flight on it, and a directory that still stands
 * where git holds no live registration. A read that failed holds it too, because a tree nobody could
 * read is a tree nobody proved empty.
 *
 * A shell is in flight on a tree in two ways. A builder's standing `working` record names it. Or the
 * tree was handed at or after its task's standing dispatch: a dispatch stands until that shell's
 * terminal moves the task, so a tree recorded since then is the one that shell runs in, whichever
 * shell it is. A tree handed before the standing dispatch belongs to a shell that already returned.
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
import type {Instant} from "../wire/lane-record.ts";
import type {WorkingTrees} from "./assembly.ts";
import type {LogEntry} from "./fold.ts";
import type {HandedTree} from "./worktrees.ts";

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
	| {readonly _tag: "InFlight"; readonly by: FlightProof}
	| {readonly _tag: "Unreadable"; readonly reason: string}
	| {readonly _tag: "Read"; readonly uncommitted: number; readonly commits: Commits};

/** What says a shell is still in the tree: a builder's seat, or a dispatch no terminal has answered. */
export type FlightProof = "working" | "dispatch";

const IN_FLIGHT_BECAUSE: Record<FlightProof, string> = {
	working: "a builder's in-flight record still stands on it, so its shell has not returned",
	dispatch:
		"it was handed at or after its task's standing dispatch, and that shell has recorded no terminal",
};

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
			return {_tag: "Kept", reason: "in-flight", detail: IN_FLIGHT_BECAUSE[state.by]};
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
	| {readonly _tag: "InFlight"; readonly by: FlightProof}
	/** A live linked worktree; `path` is the spelling git lists it under. */
	| {readonly _tag: "Linked"; readonly path: string};

/** The lane's standing in-flight records, as far as a tree's seat asks. */
export interface Flight {
	/** Every tree a builder's standing `working` record names. */
	readonly working: ReadonlySet<string>;
	/** When each task's standing dispatch was recorded. A task with none is absent. */
	readonly dispatched: ReadonlyMap<string, Instant>;
}

/**
 * Seat one recorded tree. Every path handed in is already resolved the same way, so two spellings
 * of one directory compare equal.
 *
 * The main tree is tested first: it outranks every other answer, the caller's included. A tree's
 * `task` is the one it was recorded under, and `null` is how a driver records its own.
 *
 * A tree handed in the same instant as its task's dispatch counts as in flight: the tie cannot be
 * ordered, and keeping is the answer that loses nothing.
 */
export const seatOf = (
	{worktree, task, at}: HandedTree,
	trees: WorkingTrees,
	caller: string,
	flight: Flight,
): Seat => {
	if (worktree === trees.main.path) return {_tag: "Main"};
	const entry = trees.linked.find((linked) => linked.path === worktree);
	if (entry === undefined || entry.prunable) {
		return {_tag: "Unregistered", prunable: entry !== undefined};
	}
	if (worktree === caller) return {_tag: "Caller"};
	if (task === null) return {_tag: "Driver"};
	if (flight.working.has(worktree)) return {_tag: "InFlight", by: "working"};
	const dispatched = flight.dispatched.get(task);
	if (dispatched !== undefined && Date.parse(at) >= Date.parse(dispatched)) {
		return {_tag: "InFlight", by: "dispatch"};
	}
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
