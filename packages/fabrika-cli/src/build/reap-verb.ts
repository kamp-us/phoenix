/**
 * `build reap` — reclaim the finished agent worktrees this clone never removed.
 *
 * The leak: the harness registers a worktree per spawned agent under `.claude/worktrees/agent-*`
 * and nothing removes one when its agent finishes, so registrations pile up until a live lane has
 * to reason about whether a dead checkout is a sibling holding its branch — a false signal sitting
 * directly upstream of a force-push decision.
 *
 * `build retire` does not cover this: that verb targets the trees holding ONE number's lane branch
 * and needs a board statement about that number to release them. A finished agent tree usually holds
 * no lane branch at all — the harness detaches it — so there is no number to ask the board about.
 * This verb asks git first, and removes what git proves loses nothing. It asks the board only about
 * a tree that holds something a removal would lose, and only when that tree stands on a branch.
 *
 * The order is the contract:
 *
 *   1. This run's own tree root is read, so no pass can remove the checkout it is standing in.
 *   2. Every registration is read whole (`./git.ts`) and narrowed to the agent population — both
 *      namings the harness provisions under, per `./reap.ts`'s `isAgentWorktree`.
 *   3. The trunk is resolved (`../io/trunk.ts`), never spelled — a wrong ref resolves to nothing
 *      and would make every tree look unlanded.
 *   4. Trees are seated **one at a time, in registration order**. Each gets one stat, and the arms
 *      answerable off that plus the registration's own fields run first ({@link classifyCheap}).
 *      What they leave open pays for the `git status`, the containment scan and the count of
 *      commits no ref reaches ({@link classifyGit}). Only a tree those leave open — one holding
 *      uncommitted paths or unreached commits — costs a board read. **Every read that fails is a
 *      KEEP**, per-tree: a sweep of seventy trees must not lose its whole answer to one unreadable
 *      directory.
 *   5. Nothing is removed at all without `--execute`. The default run seats the whole population and
 *      prints every verdict.
 *   6. Under `--execute` a tree seated `Remove` is removed **before the next tree is read**. `--limit`
 *      bounds the removals attempted, and the scan stops the moment that bound is spent: the trees
 *      past it are never read, and are reported as a count. So a bounded pass costs what it takes
 *      to find that many removable trees, not a scan of the population.
 *   7. Each removal runs plain `git worktree remove` — never `--force`, which is banned on every
 *      path. A tree the board released while it held uncommitted paths has them committed onto its
 *      own branch first, because git refuses to remove a dirty tree. Every removal is read back off
 *      a second `worktree list`.
 *   8. Each removal git reports is appended to {@link REAP_JOURNAL} under this run's tree root
 *      before the next tree is read, so a sweep killed mid-loop still leaves its executed set
 *      readable on disk. The read-back at 7 proves the sweep; the journal is what survives a
 *      process that never reaches it. A journal write that fails is reported and demotes nothing —
 *      the removal is the fact, the record is the convenience.
 *   9. Then the stale registrations go, in the same pass: the ones whose directory was already gone
 *      and the ones each removal just left behind. `git worktree prune` clears the record and the
 *      same read-back proves it. `--limit` does not bound this — a registration is a line in a file,
 *      not a tree to delete — and a surviving one is reported without redding the sweep, because it
 *      costs disk nothing and risks no work.
 *
 * It removes the tree and leaves the branch, exactly as `build retire` does: a removal frees a
 * checkout, it does not delete a ref.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10342#issuecomment-5973709319
 * @ruling https://github.com/kamp-us/phoenix/issues/10342#issuecomment-5973715141
 */
import {Effect, FileSystem, Option, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {containmentOf} from "../io/containment.ts";
import {appendText} from "../io/fs.ts";
import {type Attempt, fail} from "../io/git.ts";
import {getIssue, resolveRepo} from "../io/issues.ts";
import {pullsForBranch} from "../io/pulls.ts";
import {resolveTrunk, trunkUnresolved} from "../io/trunk.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {
	commitsNoRefReaches,
	pruneWorktrees,
	removeWorktree,
	salvageWorktree,
	unlockWorktree,
	type WorktreeRegistration,
	worktreeRegistrations,
	worktreeStatusPaths,
} from "./git.ts";
import {
	type BranchFate,
	type CheapFacts,
	classify,
	classifyCheap,
	classifyGit,
	fateOfPulls,
	fateOfTicket,
	isAgentWorktree,
	type License,
	type Liveness,
	type Presence,
	QUIET_WINDOW_SECONDS,
	type Stranded,
	type TreeFacts,
	ticketOf,
	type Uncommitted,
	unprovenAmong,
	type Verdict,
} from "./reap.ts";
import {readTree} from "./tree.ts";

const VERB = "fabrika build reap";

/**
 * Where the removals land as they happen, relative to this run's own tree root.
 *
 * A leaf of `.fabrika/`, which the repository gitignores whole, so the record of a machine-local
 * sweep never reaches a diff.
 */
export const REAP_JOURNAL = ".fabrika/reap.jsonl";

export interface ReapOptions {
	/** Removals happen only under this flag. Default is a dry run that mutates nothing. */
	readonly execute: boolean;
	/** At most this many removals are attempted; `null` attempts every removable tree. */
	readonly limit: number | null;
	/** Where the target repo and the credential for its trunk read resolve from. */
	readonly env: Readonly<Record<string, string | undefined>>;
}

type Deps = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

/** What every tree of one run is seated against. */
interface Ground {
	readonly trunk: string;
	readonly repo: string;
	readonly selfPaths: ReadonlySet<string>;
}

interface Seat {
	readonly facts: CheapFacts;
	readonly verdict: Verdict;
}

type Removing = Extract<Verdict, {readonly _tag: "Remove"}>;

interface Removed {
	readonly path: string;
	readonly license: License;
	/** Uncommitted paths committed onto the tree's branch before it went; `0` for a clean tree. */
	readonly salvaged: number;
}

export const runReap = (options: ReapOptions): Effect.Effect<VerbOutcome, never, Deps> =>
	Effect.gen(function* () {
		if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
			return refuse(FAILED, `${VERB}: --limit "${options.limit}" is not a positive integer.`);
		}

		const self = yield* readTree;
		if (self._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read this run's own tree root: ${self.reason} — a run that cannot recognise itself must remove nothing.`,
			);
		}

		const registrations = yield* worktreeRegistrations;
		if (registrations._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read this clone's worktree registrations: ${registrations.reason} — what is registered is UNKNOWN.`,
			);
		}
		const population = registrations.value.filter((tree) => isAgentWorktree(tree.path));
		const scope = `${VERB}: scanned ${registrations.value.length} registration(s); ${population.length} named .claude/worktrees/agent-* or pi-worktree-*.`;
		if (population.length === 0) {
			return answer(
				JSON.stringify({answer: "none", executed: options.execute, removed: [], kept: []}),
				[scope, `${VERB}: no agent worktree is registered in this clone — nothing to reap.`],
			);
		}

		const resolved = yield* resolveTrunk(options.env, null);
		const repo = yield* resolveRepo(null, options.env);
		if (resolved._tag === "Failure" || repo._tag === "Failure") {
			const reason =
				resolved._tag === "Failure" ? resolved.reason : "the target repo is unresolvable";
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${trunkUnresolved(reason)}. Whether any tree's work landed is UNKNOWN, and an unnameable trunk must reap nothing.`,
				[scope],
			);
		}
		const trunk = resolved.value.ref;
		const ground: Ground = {trunk, repo: repo.value, selfPaths: new Set([self.value.root])};

		if (!options.execute) {
			const seated: Array<Seat> = [];
			for (const tree of population) seated.push(yield* seatOf(tree, ground));
			const removable = seated.flatMap(({facts, verdict}) =>
				verdict._tag === "Remove" ? [{path: facts.path, license: verdict.license}] : [],
			);
			const bounded =
				options.limit === null ? removable.length : Math.min(options.limit, removable.length);
			return answer(
				JSON.stringify({
					answer: "planned",
					executed: false,
					trunk,
					scanned: seated.length,
					removable,
					stale: staleAmong(seated),
					kept: keptAmong(seated),
				}),
				[
					scope,
					...seated.flatMap(({facts, verdict}) =>
						verdict._tag === "Remove"
							? [`${VERB}: REMOVE ${facts.path}${branchOf(facts)} — ${verdict.because}.`]
							: [],
					),
					...staleLines(seated),
					...keptLines(seated),
					...(options.limit === null
						? []
						: [
								`${VERB}: --limit ${options.limit} bounds this sweep to ${bounded} of ${removable.length} removable tree(s); the other ${removable.length - bounded} stay registered for a later run.`,
							]),
					`${VERB}: ${removable.length} removable, ${staleAmong(seated).length} stale, ${keptAmong(seated).length} kept — nothing was removed and nothing was pruned; re-run with --execute.`,
				],
			);
		}

		const journalPath = (yield* Path.Path).join(self.value.root, REAP_JOURNAL);
		const run = new Date().toISOString();
		const seated: Array<Seat> = [];
		const removed: Array<Removed> = [];
		const failed: Array<{path: string; reason: string}> = [];
		const unjournalled: Array<{path: string; reason: string}> = [];
		for (const tree of population) {
			// The bound is on removals attempted, and it is checked before the next tree is read: a
			// tree past it pays for no stat, no git read and no board read.
			if (options.limit !== null && removed.length + failed.length >= options.limit) break;
			const seat = yield* seatOf(tree, ground);
			seated.push(seat);
			if (seat.verdict._tag !== "Remove") continue;
			const gone = yield* take(tree.path, seat.verdict);
			if (gone._tag === "Failure") {
				failed.push({path: tree.path, reason: gone.reason});
				continue;
			}
			const row: Removed = {
				path: tree.path,
				license: seat.verdict.license,
				salvaged: seat.verdict.salvage?.paths ?? 0,
			};
			removed.push(row);
			const written = yield* Effect.result(
				appendText(journalPath, `${JSON.stringify({run, trunk, ...row})}\n`),
			);
			if (Result.isFailure(written)) {
				unjournalled.push({path: tree.path, reason: written.failure.reason});
			}
		}
		const unscanned = population.length - seated.length;
		const stale = staleAmong(seated);
		const kept = keptAmong(seated);

		const journalLines = unjournalled.map(
			(row) =>
				`${VERB}: NOT JOURNALLED — ${row.path} was removed and the record did not land in ${journalPath}: ${row.reason}. The removal stands; a run killed after this point leaves it off the disk record.`,
		);

		// The registration a removed tree leaves behind is stale by the same definition as one whose
		// directory was already gone, so one prune after the loop clears both. An entry locked by a
		// dead harness process is unlocked first, because prune skips a locked entry — and its
		// directory is already proved absent, so the lock is guarding nothing.
		const unlockFailed: Array<{path: string; reason: string}> = [];
		let pruneFailure: string | null = null;
		if (stale.length > 0 || removed.length > 0) {
			for (const row of stale) {
				if (!row.locked) continue;
				const unlocked = yield* unlockWorktree(row.path);
				if (unlocked._tag === "Failure") {
					unlockFailed.push({path: row.path, reason: unlocked.reason});
				}
			}
			const pruned = yield* pruneWorktrees;
			if (pruned._tag === "Failure") pruneFailure = pruned.reason;
		}

		let unproven: ReadonlyArray<string> = [];
		let unpruned: ReadonlyArray<string> = [];
		if (removed.length > 0 || stale.length > 0) {
			const after = yield* worktreeRegistrations;
			if (after._tag === "Failure") {
				return refuse(
					READBACK_MISMATCH,
					`${VERB}: ${removed.length} tree(s) were removed and ${stale.length} stale registration(s) pruned, and the registrations could not be read back: ${after.reason} — neither is proven.`,
					[scope, ...journalLines, ...keptLines(seated)],
				);
			}
			const registered = after.value.map((tree) => tree.path);
			unproven = unprovenAmong(
				removed.map((row) => row.path),
				registered,
			);
			unpruned = unprovenAmong(
				stale.map((row) => row.path),
				registered,
			);
		}

		const report = [
			scope,
			...removed
				.filter((row) => !unproven.includes(row.path))
				.map(
					(row) =>
						`${VERB}: removed ${row.path} (${row.license})${row.salvaged > 0 ? `; its ${row.salvaged} uncommitted path(s) were committed onto its branch first` : ""}.`,
				),
			...stale
				.filter((row) => !unpruned.includes(row.path))
				.map((row) => `${VERB}: pruned the stale registration ${row.path}.`),
			...failed.map(
				(row) =>
					`${VERB}: FAILED to remove ${row.path}: ${row.reason} — the tree stays registered, and --force is banned on every path.`,
			),
			...unproven.map(
				(path) =>
					`${VERB}: UNPROVEN — git reported ${path} removed and it is still registered; this clone needs a human.`,
			),
			...unlockFailed.map(
				(row) =>
					`${VERB}: FAILED to unlock ${row.path}: ${row.reason} — prune skips a locked entry, so the registration stays.`,
			),
			...(pruneFailure === null
				? []
				: [
						`${VERB}: FAILED to prune: ${pruneFailure} — every stale registration stays, and no tree removal is affected.`,
					]),
			...unpruned.map(
				(path) =>
					`${VERB}: UNPRUNED — ${path} has no directory and is still registered after the prune.`,
			),
			...journalLines,
			...(unscanned === 0
				? []
				: [
						`${VERB}: --limit ${options.limit} was spent after ${seated.length} of ${population.length} tree(s); the other ${unscanned} were not read and stay registered for a later run.`,
					]),
			...keptLines(seated),
		];

		if (unproven.length > 0) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: ${unproven.length} removal(s) read back as still registered — reported as failures, never successes.`,
				report,
			);
		}
		if (failed.length > 0) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: git refused ${failed.length} removal(s); ${removed.length} were removed and proven. Each refusal is an incident to file (/report), not an override.`,
				report,
			);
		}
		// A surviving stale registration costs disk nothing and never risks work — its tree is already
		// gone — so it is reported and does not red a sweep whose removals all landed.
		return answer(
			JSON.stringify({
				answer: "reaped",
				executed: true,
				trunk,
				scanned: seated.length,
				unscanned,
				journal: journalPath,
				removed,
				pruned: stale.filter((row) => !unpruned.includes(row.path)).map((row) => row.path),
				unpruned,
				failed,
				kept,
			}),
			[
				...report,
				`${VERB}: ${removed.length} removed, ${stale.length - unpruned.length} pruned, ${unscanned} not scanned, ${kept.length} kept.`,
			],
		);
	});

const branchOf = (facts: CheapFacts): string =>
	facts.branch === null ? " (detached)" : ` (${facts.branch})`;

const keptAmong = (seated: ReadonlyArray<Seat>) =>
	seated.flatMap(({facts, verdict}) =>
		verdict._tag === "Keep"
			? [{path: facts.path, branch: facts.branch, reason: verdict.because}]
			: [],
	);

const keptLines = (seated: ReadonlyArray<Seat>): ReadonlyArray<string> =>
	seated.flatMap(({facts, verdict}) =>
		verdict._tag === "Keep"
			? [`${VERB}: KEEP ${facts.path}${branchOf(facts)} — ${verdict.because}.`]
			: [],
	);

const staleAmong = (seated: ReadonlyArray<Seat>) =>
	seated.flatMap(({facts, verdict}) =>
		verdict._tag === "Prune" ? [{path: facts.path, locked: facts.locked !== null}] : [],
	);

const staleLines = (seated: ReadonlyArray<Seat>): ReadonlyArray<string> =>
	seated.flatMap(({facts, verdict}) =>
		verdict._tag === "Prune"
			? [`${VERB}: PRUNE ${facts.path}${branchOf(facts)} — ${verdict.because}.`]
			: [],
	);

/**
 * Seat one tree, paying for each read only when the arms before it left the tree open.
 *
 * The stat settles most of a population. The three git reads are owed only by what it leaves open,
 * and the board is asked only about a tree those three left open.
 */
const seatOf = (tree: WorktreeRegistration, ground: Ground): Effect.Effect<Seat, never, Deps> =>
	Effect.gen(function* () {
		const observed = yield* observe(tree.path);
		const cheap: CheapFacts = {
			path: tree.path,
			branch: tree.branch,
			locked: tree.locked,
			presence: observed.presence,
			liveness: observed.liveness,
		};
		const settled = classifyCheap(cheap, ground.selfPaths);
		if (settled !== null) return {facts: cheap, verdict: settled};

		const facts: TreeFacts = {
			...cheap,
			uncommitted: yield* uncommittedIn(tree.path),
			landing: yield* containmentOf(tree.head, ground.trunk),
			stranded: yield* strandedIn(tree.path),
		};
		const byGit = classifyGit(facts, ground.trunk, ground.selfPaths);
		if (byGit !== null) return {facts, verdict: byGit};

		const fate = yield* fateOf(ground.repo, tree.branch);
		return {facts, verdict: classify({...facts, fate}, ground.trunk, ground.selfPaths)};
	});

/**
 * Remove one tree by the route its verdict names.
 *
 * A salvage that fails leaves the tree standing: removing it then would need `--force`, and would
 * destroy the only copy of what it holds.
 */
const take = (
	path: string,
	verdict: Removing,
): Effect.Effect<Attempt<void>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (verdict.salvage !== null) {
			const {paths, onto} = verdict.salvage;
			const committed = yield* salvageWorktree(
				path,
				`wip: salvage ${paths} uncommitted path(s) from a reaped worktree (${onto})\n`,
			);
			if (committed._tag === "Failure") {
				return fail(
					`its ${paths} uncommitted path(s) could not be committed onto ${onto} first: ${committed.reason}`,
				);
			}
		}
		return yield* removeWorktree(path);
	});

/**
 * What the board proves about the branch a tree holds: its pull requests first, then the issue its
 * name carries a number for.
 *
 * The pull requests are asked first because an open one keeps the tree whatever the issue says. A
 * detached tree is never asked about by commit: a commit on the trunk belongs to a merged pull
 * request, and that would read every long-lived detached checkout as finished.
 */
const fateOf = (
	repo: string,
	branch: string | null,
): Effect.Effect<BranchFate, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const unproven = (reason: string): BranchFate => ({_tag: "Unproven", reason});
		if (branch === null) {
			return unproven("it holds no branch, so there is no issue or pull request to ask about");
		}
		const pulls = yield* pullsForBranch(repo, branch);
		if (pulls._tag === "Failure") {
			return unproven(`the pull requests on ${branch} could not be read: ${pulls.reason}`);
		}
		const byPulls = fateOfPulls(
			branch,
			pulls.value.map((pull) => ({
				number: pull.number,
				state: pull.state,
				merged: pull.mergedAt !== null,
			})),
		);
		if (byPulls !== null) return byPulls;

		const number = ticketOf(branch);
		if (number === null) {
			return unproven(
				`no pull request has ${branch} as its head, and its name carries no issue number`,
			);
		}
		const ticket = yield* getIssue(repo, number);
		if (ticket._tag === "Absent") {
			return unproven(`no pull request has ${branch} as its head, and #${number} does not exist`);
		}
		if (ticket._tag === "Unknown") {
			return unproven(`#${number} could not be read: ${ticket.reason}`);
		}
		return fateOfTicket(branch, ticket.value);
	});

/** A tree's uncommitted count, or the reason it is UNKNOWN. Asked only of a tree still on disk. */
const uncommittedIn = (
	path: string,
): Effect.Effect<Uncommitted, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const dirty = yield* worktreeStatusPaths(path);
		return dirty._tag === "Failure"
			? {_tag: "Unknown" as const, reason: dirty.reason}
			: {_tag: "Read" as const, paths: dirty.value};
	});

/** How many commits a tree holds that no ref reaches, or the reason that is UNKNOWN. */
const strandedIn = (
	path: string,
): Effect.Effect<Stranded, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const count = yield* commitsNoRefReaches(path);
		return count._tag === "Failure"
			? {_tag: "Unknown" as const, reason: count.reason}
			: {_tag: "Read" as const, commits: count.value};
	});

/**
 * The one stat, read into both facts it answers: is the directory still there, and does it read
 * as in use?
 *
 * **Absence is proved by this stat's own `NotFound`, never by a failed read and never by another
 * program's hint.** `FileSystem.stat` folds every failure into a `PlatformError`, and only
 * `reason._tag === "NotFound"` is a not-there; a `PermissionDenied` or an unmounted volume arrives
 * as some other tag and keeps the tree. Verified against this repo's `effect@4.0.0-beta.92` under
 * `NodeServices.layer`: a missing path answered `NotFound` and an unreadable one `PermissionDenied`.
 *
 * git's own `prunable` flag is **not** that proof and is not consulted here. Its condition is the
 * `<worktree>/.git` file, not the `<worktree>` directory, so a checkout whose `.git` file was
 * deleted while its files stayed reports prunable with uncommitted work still on disk — measured
 * against real git in `./stale-registration.git.test.ts`. Seating `Gone` off it would clear that
 * registration and delete `.git/worktrees/<id>`, taking the only ref a commit living solely in that
 * worktree has. The stat is the wider source anyway: every registration git calls prunable *because*
 * its directory is gone answers `NotFound` here, and the locked-and-gone entries git's own prune
 * skips are reached only through this read.
 *
 * The liveness signal is the worktree root's own mtime, and that tracks the root's **entry list** —
 * a create, delete or rename directly in it — not a write to a file inside it. So for a seat that
 * drives without editing, this reads the tree's provisioning time, and a young tree is one
 * provisioned recently rather than one somebody was recently active in; {@link QUIET_WINDOW_SECONDS}
 * carries the ground for that and what it costs. It is still the only liveness reading available
 * without asking the OS for process cwds.
 *
 * A clock skew that puts the mtime in the future reads Live, not Quiet: the arm's whole polarity is
 * that an answer it cannot trust must not license a removal.
 */
const observe = (
	path: string,
): Effect.Effect<
	{readonly presence: Presence; readonly liveness: Liveness},
	never,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const gone = (because: string) =>
			({
				presence: {_tag: "Gone" as const, because},
				liveness: {_tag: "Unknown" as const, reason: "its directory is gone"},
			}) as const;

		const fs = yield* FileSystem.FileSystem;
		const stat = yield* Effect.result(fs.stat(path));
		if (Result.isFailure(stat)) {
			const reason = stat.failure.reason;
			if (reason._tag === "NotFound") {
				return gone(
					"its directory does not exist, so there is nothing to salvage and the registration is all that is left",
				);
			}
			const unreadable = `its directory could not be read: ${stat.failure.message}`;
			return {
				presence: {_tag: "Unknown" as const, reason: unreadable},
				liveness: {_tag: "Unknown" as const, reason: unreadable},
			};
		}

		const mtime = stat.success.mtime;
		if (Option.isNone(mtime)) {
			return {
				presence: {_tag: "Present" as const},
				liveness: {
					_tag: "Unknown" as const,
					reason: "this platform reported no modification time for it",
				},
			};
		}
		const ageSeconds = Math.floor((Date.now() - mtime.value.getTime()) / 1000);
		return {
			presence: {_tag: "Present" as const},
			liveness:
				ageSeconds >= QUIET_WINDOW_SECONDS
					? ({_tag: "Quiet"} as const)
					: ({
							_tag: "Live",
							signals: [
								{_tag: "RecentActivity" as const, ageSeconds, windowSeconds: QUIET_WINDOW_SECONDS},
							],
						} as const),
		};
	});
