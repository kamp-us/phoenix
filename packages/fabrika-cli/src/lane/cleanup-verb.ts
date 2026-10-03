/**
 * `lane cleanup` — remove the worktrees a lane's shells were handed, under the keep rule in
 * [`cleanup.ts`](cleanup.ts), and name every one it did not remove.
 *
 * The set is the lane's own record ([`worktrees.ts`](worktrees.ts)) and nothing else: no tree is
 * found by listing a directory or by its name, so a tree the lane never recorded is out of reach by
 * construction. Each removal is a plain `git worktree remove` run by this process — a shell in an
 * isolated worktree is refused a typed git command against another tree, and a verb's own child
 * process is not. There is no `--force` anywhere in this file.
 *
 * The board is read only for a tree whose commits are on no remote ref, to ask whether one of the
 * lane's pull requests merged with them. Every other tree is settled by git alone.
 *
 * Nothing holds the ledger lock while trees are read or removed, because a removal deletes an
 * installed tree and can run long. The lock is taken once, at the end, for the `removed` lines.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10340
 */
import {Effect, FileSystem, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "../io/exec.ts";
import {appendText} from "../io/fs.ts";
import {type Attempt, isAncestor, isObjectName} from "../io/git.ts";
import {resolveRepo} from "../io/issues.ts";
import {getPullRequest} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {instant} from "../wire/lane-record.ts";
import {withLedgerLock} from "./append-lock.ts";
import {type WorkingTrees, worktrees} from "./assembly.ts";
import {
	type Commits,
	type Disposition,
	dispose,
	lanePulls,
	seatOf,
	type TreeState,
} from "./cleanup.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE, MALFORMED_RECORD, TREES_KEPT} from "./codes.ts";
import {inFlight, loadInFlight} from "./in-flight.ts";
import {loadRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";
import {encodeWorktree, handedTrees, loadWorktrees} from "./worktrees.ts";

const VERB = "fabrika lane cleanup";

/** What the board says about one of the lane's pull requests, as far as this verb asks. */
export type PullRead =
	| {readonly _tag: "Merged"; readonly headSha: string}
	| {readonly _tag: "Unmerged"}
	| {readonly _tag: "Unknown"; readonly reason: string};

export type PullReader<R> = (pull: number) => Effect.Effect<PullRead, never, R>;

export interface CleanupOptions<R> extends LaneRef {
	/** The tree this process runs in, read off git by the adapter. */
	readonly caller: Attempt<string>;
	readonly pull: PullReader<R>;
}

type Services = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

/**
 * The board's answer for one pull request, with the repo resolved once. A reader the caller passes
 * rather than a seam this verb reaches through, so an unreadable board stays `Unknown` and every
 * arm of the keep rule is testable offline.
 */
export const boardPull = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): PullReader<ChildProcessSpawner.ChildProcessSpawner> => {
	let resolved: string | null = null;
	return (pull) =>
		Effect.gen(function* () {
			if (resolved === null) {
				const attempt = yield* resolveRepo(repo, env);
				if (attempt._tag === "Failure") {
					return {
						_tag: "Unknown",
						reason: "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name",
					} as const;
				}
				resolved = attempt.value;
			}
			const record = yield* getPullRequest(resolved, pull);
			if (record._tag === "Unknown") return {_tag: "Unknown", reason: record.reason} as const;
			if (record._tag === "Absent") {
				return {_tag: "Unknown", reason: `no such pull request on ${resolved}`} as const;
			}
			return record.value.merged
				? ({_tag: "Merged", headSha: record.value.headSha} as const)
				: ({_tag: "Unmerged"} as const);
		});
};

/** Where `head`'s local-only commits live: a merged pull request of the lane, or nowhere proven. */
const localOnly = <R>(
	head: string,
	count: number,
	pulls: ReadonlyArray<number>,
	read: PullReader<R>,
): Effect.Effect<Commits, never, R | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (pulls.length === 0) {
			return {_tag: "LocalOnly", count, why: "the lane's log names no pull request"} as const;
		}
		const misses: string[] = [];
		for (const pull of pulls) {
			const state = yield* read(pull);
			if (state._tag === "Unknown") misses.push(`#${pull} could not be read (${state.reason})`);
			else if (state._tag === "Unmerged") misses.push(`#${pull} is not merged`);
			else if (state.headSha === head || (yield* isAncestor(head, state.headSha))) {
				return {_tag: "Merged", pull} as const;
			} else misses.push(`merged #${pull} does not carry ${head.slice(0, 12)}`);
		}
		return {_tag: "LocalOnly", count, why: misses.join("; ")} as const;
	});

/** Read one live linked worktree: what it holds uncommitted, and where its commits live. */
const readTree = <R>(
	path: string,
	pulls: ReadonlyArray<number>,
	read: PullReader<R>,
): Effect.Effect<TreeState, never, R | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const status = yield* execCapture("git", ["-C", path, "status", "--porcelain"]);
		if (!status.ok) {
			return {
				_tag: "Unreadable",
				reason: `its status could not be read: ${status.reason}`,
			} as const;
		}
		const uncommitted = status.stdout.split("\n").filter((line) => line.trim() !== "").length;
		if (uncommitted > 0) return {_tag: "Read", uncommitted, commits: {_tag: "Published"}} as const;
		const ahead = yield* execCapture("git", [
			"-C",
			path,
			"rev-list",
			"--count",
			"HEAD",
			"--not",
			"--remotes",
		]);
		const count = Number(ahead.stdout.trim());
		if (!ahead.ok || ahead.stdout.trim() === "" || !Number.isInteger(count)) {
			return {
				_tag: "Unreadable",
				reason: `its commits could not be counted against the remote refs${ahead.ok ? "" : `: ${ahead.reason}`}`,
			} as const;
		}
		if (count === 0) return {_tag: "Read", uncommitted, commits: {_tag: "Published"}} as const;
		const head = yield* execCapture("git", ["-C", path, "rev-parse", "HEAD"]);
		if (!head.ok || !isObjectName(head.stdout)) {
			return {_tag: "Unreadable", reason: `its HEAD could not be read: ${head.reason}`} as const;
		}
		const commits = yield* localOnly(head.stdout.trim(), count, pulls, read);
		return {_tag: "Read", uncommitted, commits} as const;
	});

interface Judged {
	readonly worktree: string;
	readonly disposition: Disposition;
}

const lineOf = ({worktree, disposition}: Judged): string => {
	switch (disposition._tag) {
		case "Remove":
			return `${VERB}: removed ${worktree}`;
		case "Gone":
			return `${VERB}: gone ${worktree} — no working tree stands there any more`;
		case "Left":
			return disposition.reason === "caller"
				? `${VERB}: left ${worktree} — this verb runs in it; it is the caller's to remove from outside`
				: `${VERB}: left ${worktree} — the main working tree is no lane's to remove`;
		case "Kept":
			return `${VERB}: kept ${worktree} — ${disposition.reason}: ${disposition.detail}`;
	}
};

export const runCleanup = <R>(
	options: CleanupOptions<R>,
): Effect.Effect<VerbOutcome, never, R | Services> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
		const recorded = yield* loadWorktrees(loaded.dir);
		if (recorded._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read ${recorded.path}: ${recorded.reason} — which trees this lane was handed is UNKNOWN, so nothing was removed.`,
			);
		}
		if (recorded._tag === "Malformed") {
			return refuse(
				MALFORMED_RECORD,
				`${VERB}: ${recorded.path} was read in full and is not the shape — nothing was removed.`,
				recorded.defects.map((defect) => `${VERB}: defect: ${defect}`),
			);
		}
		const handed = handedTrees(recorded.records);
		if (handed.length === 0) {
			return answer(
				JSON.stringify({answer: "cleaned", lane: options.lane, removed: [], gone: [], left: []}),
				[`${VERB}: lane ${options.lane} recorded no worktree — nothing to remove.`],
			);
		}
		const seated = yield* loadInFlight(loaded.dir);
		if (seated._tag !== "Loaded") {
			return refuse(
				seated._tag === "Malformed" ? MALFORMED_RECORD : LANE_UNREADABLE,
				`${VERB}: cannot read ${seated.path} — whether a builder is still seated in one of these trees is UNKNOWN, so nothing was removed.`,
			);
		}
		if (options.caller._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read which tree this runs in: ${options.caller.reason} — nothing was removed.`,
			);
		}
		const listed = yield* worktrees;
		if (listed._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read this repository's working trees: ${listed.reason} — nothing was removed.`,
			);
		}

		// Two spellings of one directory compare unequal as strings, and git's own list disagrees
		// with `rev-parse` on a symlinked prefix. A path that resolves nowhere keeps its spelling.
		const real = (raw: string) =>
			Effect.map(Effect.result(fs.realPath(raw)), (resolved) =>
				Result.isSuccess(resolved) ? resolved.success : raw,
			);
		const resolve = (trees: WorkingTrees) =>
			Effect.gen(function* () {
				const linked = [];
				for (const entry of trees.linked) linked.push({...entry, path: yield* real(entry.path)});
				return {main: {...trees.main, path: yield* real(trees.main.path)}, linked};
			});
		const before = yield* resolve(listed.value);
		const caller = yield* real(options.caller.value);
		const working = new Set<string>();
		for (const seat of Object.values(inFlight(seated.records, loaded.entries))) {
			if (seat.working !== null) working.add(yield* real(seat.working.worktree));
		}

		const pulls = lanePulls(loaded.entries);
		const judged: Judged[] = [];
		const asked: Array<{readonly worktree: string; readonly real: string; readonly why: string}> =
			[];
		for (const tree of handed) {
			const resolved = yield* real(tree.worktree);
			const seat = seatOf(resolved, before, caller, working);
			const state: TreeState =
				seat._tag === "Linked" ? yield* readTree(tree.worktree, pulls, options.pull) : seat;
			const disposition = dispose(state);
			if (disposition._tag !== "Remove") {
				judged.push({worktree: tree.worktree, disposition});
				continue;
			}
			const removed = yield* execCapture("git", ["worktree", "remove", tree.worktree]);
			asked.push({worktree: tree.worktree, real: resolved, why: removed.ok ? "" : removed.reason});
		}

		if (asked.length > 0) {
			const relisted = yield* worktrees;
			if (relisted._tag === "Failure") {
				return refuse(
					APPEND_UNKNOWN,
					`${VERB}: ran ${asked.length} removal(s) and cannot re-read the working trees: ${relisted.reason} — which of them landed is UNKNOWN.`,
					asked.map(({worktree}) => `${VERB}: removal attempted: ${worktree}`),
				);
			}
			const after = yield* resolve(relisted.value);
			for (const {worktree, real: resolved, why} of asked) {
				const survives = after.linked.some((entry) => entry.path === resolved && !entry.prunable);
				judged.push({
					worktree,
					disposition: survives
						? {
								_tag: "Kept",
								reason: "remove-refused",
								detail: why === "" ? "git reported success and the tree still stands" : why,
							}
						: {_tag: "Remove"},
				});
			}
		}

		const retired = judged.filter(
			({disposition}) => disposition._tag === "Remove" || disposition._tag === "Gone",
		);
		const notes: string[] = [];
		if (retired.length > 0) {
			const unrecorded = (why: string): string =>
				`${VERB}: the removed lines did not land in ${recorded.path}: ${why} — the next run reads those trees as gone and records it then.`;
			const at = instant(yield* Effect.sync(() => new Date().toISOString()));
			const note =
				at === null
					? unrecorded("the clock gave no instant")
					: yield* withLedgerLock(
							{fs, path, dir: loaded.dir, verb: VERB},
							Effect.map(
								Effect.result(
									appendText(
										recorded.path,
										retired
											.map(({worktree}) => encodeWorktree({kind: "removed", worktree, at}))
											.join(""),
									),
								),
								(wrote) => (Result.isFailure(wrote) ? unrecorded(wrote.failure.reason) : null),
							),
							{
								onAbsent: () => unrecorded("the lane is no longer there"),
								onLocked: (_lockDir, reason) => unrecorded(reason),
							},
						);
			if (note !== null) notes.push(note);
		}

		const lines = [...judged.map(lineOf), ...notes];
		const kept = judged.filter(({disposition}) => disposition._tag === "Kept");
		if (kept.length > 0) {
			return refuse(
				TREES_KEPT,
				`${VERB}: lane ${options.lane} — ${kept.length} of ${judged.length} recorded worktree(s) kept; each is named above with its reason. Nothing was forced.`,
				lines,
			);
		}
		const pathsOf = (tag: Disposition["_tag"]) =>
			judged.filter(({disposition}) => disposition._tag === tag).map(({worktree}) => worktree);
		return answer(
			JSON.stringify({
				answer: "cleaned",
				lane: options.lane,
				removed: pathsOf("Remove"),
				gone: pathsOf("Gone"),
				left: judged.flatMap(({worktree, disposition}) =>
					disposition._tag === "Left" ? [{worktree, reason: disposition.reason}] : [],
				),
			}),
			lines,
		);
	});
