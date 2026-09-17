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
 * This verb asks git instead, and reclaims only what git can prove — plus one non-git question on the
 * same fail-safe polarity: is the tree still in use? Git cannot answer it, because an operator or
 * reviewer seat drives its lane without committing or editing, so `./reap.ts`'s {@link Liveness}
 * carries the tree's own recency and any live or unreadable reading is a KEEP.
 *
 * The order is the contract:
 *
 *   1. This run's own tree root is read, so no pass can remove the checkout it is standing in.
 *   2. Every registration is read whole (`./git.ts`) and narrowed to the agent population — both
 *      namings the harness provisions under, per `./reap.ts`'s `isAgentWorktree`.
 *   3. The trunk is derived from `origin/HEAD`, never spelled — a wrong ref resolves to nothing and
 *      would make every tree look unlanded.
 *   4. Each tree gets one stat, and the arms answerable off that plus the registration's own fields
 *      run first ({@link classifyCheap}). Only what they leave open pays for the `git status` and
 *      the containment scan — 13 trees of 243 on the clone this was measured against, and reading
 *      those two for the other 230 anyway is the 42.8s a sweep used to cost before a hook ran one
 *      per spawn. **Every read that fails is a KEEP**, per-tree: a sweep of seventy trees must not
 *      lose its whole answer to one unreadable directory.
 *   5. Nothing is removed at all without `--execute`. The default run prints classifications.
 *   6. `--limit` bounds the executed set to that many removals; everything past it stays planned and
 *      is reported unattempted, so a population too large for one watchdog window is walked in
 *      pieces instead of being all-or-nothing.
 *   7. Each removal runs plain `git worktree remove` — never `--force`, which is banned on every
 *      path — and every one is read back off a second `worktree list`.
 *   8. Each removal git reports is appended to {@link REAP_JOURNAL} under this run's tree root
 *      before the next candidate is attempted, so a sweep killed mid-loop still leaves its executed
 *      set readable on disk. The read-back at 7 proves the sweep; the journal is what survives a
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
 */
import {Effect, FileSystem, Option, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {containmentOf} from "../io/containment.ts";
import {appendText} from "../io/fs.ts";
import {originHeadRef} from "../io/git.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {
	pruneWorktrees,
	removeWorktree,
	unlockWorktree,
	worktreeRegistrations,
	worktreeStatusPaths,
} from "./git.ts";
import {
	type CheapFacts,
	classify,
	classifyCheap,
	isAgentWorktree,
	type License,
	type Liveness,
	type Presence,
	QUIET_WINDOW_SECONDS,
	type TreeFacts,
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
}

type Deps = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

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
		const selfPaths = new Set([self.value.root]);

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

		const trunk = yield* originHeadRef;
		if (trunk._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot name this clone's trunk: ${trunk.reason} — whether any tree's work landed is UNKNOWN, and an unnameable trunk must reap nothing.`,
				[scope],
			);
		}

		const seated: Array<{facts: CheapFacts; verdict: Verdict}> = [];
		for (const tree of population) {
			const observed = yield* observe(tree.path);
			const cheap: CheapFacts = {
				path: tree.path,
				branch: tree.branch,
				locked: tree.locked,
				presence: observed.presence,
				liveness: observed.liveness,
			};
			// The git reads are owed only by what the cheap arms leave open. On this clone that is 13
			// trees of 243, and paying for the other 230 anyway is the whole 42.8s a sweep used to cost.
			const settled = classifyCheap(cheap, selfPaths);
			if (settled !== null) {
				seated.push({facts: cheap, verdict: settled});
				continue;
			}
			const facts: TreeFacts = {
				...cheap,
				uncommitted: yield* uncommittedIn(tree.path),
				landing: yield* containmentOf(tree.head, trunk.value),
			};
			seated.push({facts, verdict: classify(facts, trunk.value, selfPaths)});
		}

		const removable = seated.flatMap(({facts, verdict}) =>
			verdict._tag === "Remove" ? [{path: facts.path, license: verdict.license}] : [],
		);
		const kept = seated.flatMap(({facts, verdict}) =>
			verdict._tag === "Keep"
				? [{path: facts.path, branch: facts.branch, reason: verdict.because}]
				: [],
		);
		const keptLines = seated.flatMap(({facts, verdict}) =>
			verdict._tag === "Keep"
				? [`${VERB}: KEEP ${facts.path}${branchOf(facts)} — ${verdict.because}.`]
				: [],
		);
		const stale = seated.flatMap(({facts, verdict}) =>
			verdict._tag === "Prune" ? [{path: facts.path, locked: facts.locked !== null}] : [],
		);
		const staleLines = seated.flatMap(({facts, verdict}) =>
			verdict._tag === "Prune"
				? [`${VERB}: PRUNE ${facts.path}${branchOf(facts)} — ${verdict.because}.`]
				: [],
		);

		const attempted = options.limit === null ? removable : removable.slice(0, options.limit);
		const unattempted = removable.slice(attempted.length);
		const boundLine =
			options.limit === null
				? []
				: [
						`${VERB}: --limit ${options.limit} bounds this sweep to ${attempted.length} of ${removable.length} removable tree(s); the other ${unattempted.length} stay registered for a later run.`,
					];

		if (!options.execute) {
			const planned = seated.flatMap(({facts, verdict}) =>
				verdict._tag === "Remove"
					? [`${VERB}: REMOVE ${facts.path}${branchOf(facts)} — ${verdict.because}.`]
					: [],
			);
			return answer(
				JSON.stringify({
					answer: "planned",
					executed: false,
					trunk: trunk.value,
					scanned: population.length,
					removable,
					stale,
					kept,
				}),
				[
					scope,
					...planned,
					...staleLines,
					...keptLines,
					...boundLine,
					`${VERB}: ${removable.length} removable, ${stale.length} stale, ${kept.length} kept — nothing was removed and nothing was pruned; re-run with --execute.`,
				],
			);
		}

		const journalPath = (yield* Path.Path).join(self.value.root, REAP_JOURNAL);
		const run = new Date().toISOString();
		const removed: Array<{path: string; license: License}> = [];
		const failed: Array<{path: string; reason: string}> = [];
		const unjournalled: Array<{path: string; reason: string}> = [];
		for (const candidate of attempted) {
			const gone = yield* removeWorktree(candidate.path);
			if (gone._tag === "Failure") {
				failed.push({path: candidate.path, reason: gone.reason});
				continue;
			}
			removed.push(candidate);
			const written = yield* Effect.result(
				appendText(
					journalPath,
					`${JSON.stringify({run, trunk: trunk.value, path: candidate.path, license: candidate.license})}\n`,
				),
			);
			if (Result.isFailure(written)) {
				unjournalled.push({path: candidate.path, reason: written.failure.reason});
			}
		}

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
					[scope, ...journalLines, ...keptLines],
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
				.map((row) => `${VERB}: removed ${row.path} (${row.license}).`),
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
			...unattempted.map(
				(row) =>
					`${VERB}: UNATTEMPTED ${row.path} (${row.license}) — past --limit ${options.limit}; it stays registered and is removable on the next run.`,
			),
			...keptLines,
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
				trunk: trunk.value,
				scanned: population.length,
				journal: journalPath,
				removed,
				pruned: stale.filter((row) => !unpruned.includes(row.path)).map((row) => row.path),
				unpruned,
				failed,
				unattempted,
				kept,
			}),
			[
				...report,
				`${VERB}: ${removed.length} removed, ${stale.length - unpruned.length} pruned, ${unattempted.length} unattempted, ${kept.length} kept.`,
			],
		);
	});

const branchOf = (facts: CheapFacts): string =>
	facts.branch === null ? " (detached)" : ` (${facts.branch})`;

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
