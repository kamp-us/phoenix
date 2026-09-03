/**
 * `build reap` — reclaim the finished agent worktrees this clone never removed.
 *
 * The leak is #6833: the harness registers a worktree per spawned agent under
 * `.claude/worktrees/agent-*` and nothing removes one when its agent finishes, so registrations pile
 * up until a live lane has to reason about whether a dead checkout is a sibling holding its branch —
 * a false signal sitting directly upstream of a force-push decision (PR #6823).
 *
 * `build retire` does not cover this: that verb targets the trees holding ONE number's lane branch
 * and needs a board statement about that number to release them. A finished agent tree usually holds
 * no lane branch at all — the harness detaches it — so there is no number to ask the board about.
 * This verb asks git instead, and reclaims only what git can prove.
 *
 * The order is the contract:
 *
 *   1. This run's own tree root is read, so no pass can remove the checkout it is standing in.
 *   2. Every registration is read whole (`./git.ts`) and narrowed to the agent population.
 *   3. The trunk is derived from `origin/HEAD`, never spelled — a wrong ref resolves to nothing and
 *      would make every tree look unlanded.
 *   4. Each tree's uncommitted count and its HEAD's landing are read, and {@link classify} seats it.
 *      **Every read that fails is a KEEP**, per-tree: a sweep of seventy trees must not lose its
 *      whole answer to one unreadable directory.
 *   5. Nothing is removed at all without `--execute`. The default run prints classifications.
 *   6. Each removal runs plain `git worktree remove` — never `--force`, which ADR 0321 bans on every
 *      path — and every one is read back off a second `worktree list`.
 *
 * It removes the tree and leaves the branch, exactly as `build retire` does: a removal frees a
 * checkout, it does not delete a ref.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	diffRange,
	diffRangePaths,
	mergeBase,
	noMergeBaseReason,
	originHeadRef,
	patchIdsIn,
	patchIdsOf,
} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {isAncestor, removeWorktree, worktreeRegistrations, worktreeStatusPaths} from "./git.ts";
import {
	classify,
	isAgentWorktree,
	type Landing,
	type License,
	type TreeFacts,
	type Uncommitted,
	unprovenAmong,
	type Verdict,
} from "./reap.ts";
import {readTree} from "./tree.ts";

const VERB = "fabrika build reap";

/**
 * How far back along the trunk a squash is looked for.
 *
 * Bounded because the scan reads patches, not commit names. Past it the answer is "not found",
 * which classifies KEEP — the fail-safe direction, and the reason a bound is allowed to exist here
 * at all.
 */
const TRUNK_SCAN = 200;

export interface ReapOptions {
	/** Removals happen only under this flag. Default is a dry run that mutates nothing. */
	readonly execute: boolean;
}

type Deps = ChildProcessSpawner.ChildProcessSpawner;

export const runReap = (options: ReapOptions): Effect.Effect<VerbOutcome, never, Deps> =>
	Effect.gen(function* () {
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
		const scope = `${VERB}: scanned ${registrations.value.length} registration(s); ${population.length} under .claude/worktrees/agent-*.`;
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

		const seated: Array<{facts: TreeFacts; verdict: Verdict}> = [];
		for (const tree of population) {
			const facts: TreeFacts = {
				path: tree.path,
				branch: tree.branch,
				locked: tree.locked,
				prunable: tree.prunable,
				uncommitted: yield* uncommittedIn(tree.path, tree.prunable),
				landing: yield* landingOf(tree.head, trunk.value),
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
					kept,
				}),
				[
					scope,
					...planned,
					...keptLines,
					`${VERB}: ${removable.length} removable, ${kept.length} kept — nothing was removed; re-run with --execute to remove them.`,
				],
			);
		}

		const removed: Array<{path: string; license: License}> = [];
		const failed: Array<{path: string; reason: string}> = [];
		for (const candidate of removable) {
			const gone = yield* removeWorktree(candidate.path);
			if (gone._tag === "Failure") failed.push({path: candidate.path, reason: gone.reason});
			else removed.push(candidate);
		}

		let unproven: ReadonlyArray<string> = [];
		if (removed.length > 0) {
			const after = yield* worktreeRegistrations;
			if (after._tag === "Failure") {
				return refuse(
					READBACK_MISMATCH,
					`${VERB}: ${removed.length} tree(s) were removed and the registrations could not be read back: ${after.reason} — the removals are NOT proven.`,
					[scope, ...keptLines],
				);
			}
			unproven = unprovenAmong(
				removed.map((row) => row.path),
				after.value.map((tree) => tree.path),
			);
		}

		const report = [
			scope,
			...removed
				.filter((row) => !unproven.includes(row.path))
				.map((row) => `${VERB}: removed ${row.path} (${row.license}).`),
			...failed.map(
				(row) =>
					`${VERB}: FAILED to remove ${row.path}: ${row.reason} — the tree stays registered, and ADR 0321 bans --force on every path.`,
			),
			...unproven.map(
				(path) =>
					`${VERB}: UNPROVEN — git reported ${path} removed and it is still registered; this clone needs a human.`,
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
		return answer(
			JSON.stringify({
				answer: "reaped",
				executed: true,
				trunk: trunk.value,
				scanned: population.length,
				removed,
				failed,
				kept,
			}),
			[...report, `${VERB}: ${removed.length} removed, ${kept.length} kept.`],
		);
	});

const branchOf = (facts: TreeFacts): string =>
	facts.branch === null ? " (detached)" : ` (${facts.branch})`;

/**
 * A tree's uncommitted count, or the reason it is UNKNOWN.
 *
 * A registration git already calls prunable has no directory to read, so it is not asked: the
 * failure would be noise on a tree {@link classify} keeps for a different reason anyway.
 */
const uncommittedIn = (path: string, prunable: boolean): Effect.Effect<Uncommitted, never, Deps> =>
	Effect.gen(function* () {
		if (prunable) return {_tag: "Unknown" as const, reason: "its directory is gone"};
		const dirty = yield* worktreeStatusPaths(path);
		return dirty._tag === "Failure"
			? {_tag: "Unknown" as const, reason: dirty.reason}
			: {_tag: "Read" as const, paths: dirty.value};
	});

/**
 * What `trunk` says about one HEAD commit — the three positive answers, or why there is none.
 *
 * The ancestor test comes first because it is one cheap call and it settles the majority: a detached
 * agent tree usually stands on the trunk commit it was spawned at. Only what survives it costs the
 * patch reads.
 *
 * The squash arm is patch-identity, not ancestry, and it was measured rather than reasoned about:
 * on `build/4082-db-schema-readme-diataxis-43cc4b51` the branch's own net patch id and the trunk
 * commit's path-limited one are both `d18b491a48c861494a35740f571a90a45b596aae`. The pathspec is
 * what makes those two comparable — limited to the paths the branch touches, a squash commit's diff
 * is that branch's net diff exactly. A squash landed on top of an intervening change to the same
 * paths will not match, and answers `Unlanded`, which is the fail-safe direction.
 */
const landingOf = (head: string, trunk: string): Effect.Effect<Landing, never, Deps> =>
	Effect.gen(function* () {
		if (head === "") return {_tag: "Unknown" as const, reason: "its record names no HEAD commit"};
		if (yield* isAncestor(head, trunk)) return {_tag: "Ancestor" as const};

		const diff = yield* diffRange(trunk, head);
		if (diff._tag === "Failure") {
			return {_tag: "Unknown" as const, reason: `cannot diff it against ${trunk}: ${diff.reason}`};
		}
		if (diff.value.trim() === "") return {_tag: "NoChange" as const};

		const own = yield* patchIdsOf(diff.value);
		const mine = own._tag === "Ok" ? own.value[0] : undefined;
		if (mine === undefined) {
			return {
				_tag: "Unknown" as const,
				reason: `cannot compute the patch id of what its HEAD adds${own._tag === "Failure" ? `: ${own.reason}` : ""}`,
			};
		}

		const paths = yield* diffRangePaths(trunk, head);
		if (paths._tag === "Failure") {
			return {
				_tag: "Unknown" as const,
				reason: `cannot list the paths it changes: ${paths.reason}`,
			};
		}
		const base = yield* mergeBase(trunk, head);
		if (base._tag === "Failure") {
			return {
				_tag: "Unknown" as const,
				reason: `it shares ${yield* noMergeBaseReason(trunk, base.reason)}`,
			};
		}
		const landed = yield* patchIdsIn(base.value, trunk, paths.value, TRUNK_SCAN);
		if (landed._tag === "Failure") {
			return {
				_tag: "Unknown" as const,
				reason: `cannot scan ${trunk} for the patch it adds: ${landed.reason}`,
			};
		}
		const match = landed.value.find((row) => row.patch === mine.patch);
		return match === undefined
			? {_tag: "Unlanded" as const}
			: {_tag: "Squashed" as const, commit: match.commit};
	});
