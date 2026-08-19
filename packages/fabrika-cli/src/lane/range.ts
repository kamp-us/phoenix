/**
 * The one commit range an epic run's child built, read off this tree's refs and object database.
 *
 * Off the tree rather than off a search index because a child's work is never published: nothing on
 * GitHub knows it exists until the epic's single PR opens at the tail (ADR 0285). The branch is
 * nominated by `build branch`'s own grammar (`./prove.ts`'s `childLaneBranches`, never a second
 * regex) and the range is then the evidence — a branch is only a name until commits naming this
 * child sit on it.
 *
 * **This answers what the tree says; the exit code is the caller's.** `lane prove` reads the answer
 * as a proof and `lane brief` hands the same two endpoints to the reviewer it dispatches, so the two
 * verbs cannot name different ranges for one child — the defect that let a brief print
 * `epic/<n>..HEAD`, which the *spawned* shell re-resolved in its own worktree to an empty range
 * (#6023).
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	type Attempt,
	localBranches,
	mergeBase,
	ok,
	rangeCommits,
	rangeParents,
	resolveCommit,
	type Shell,
} from "../io/git.ts";
import {epicBranch} from "../wire/lane-brief.ts";
import {type BranchFact, childLaneBranches, integratedFrom, traceRange} from "./prove.ts";

/** The located range: the branch it was read off, and the two commits that bound it. */
export interface ChildRange {
	readonly branch: string;
	/** Where the branch forked from the epic branch — never that branch's tip. See {@link forkPoint}. */
	readonly base: string;
	readonly tip: string;
	/** Every commit the range adds — the artifact's size. */
	readonly commits: number;
	/** How many of those name this child — the evidence the range is this child's. */
	readonly naming: number;
}

/**
 * What this tree says about the child's range.
 *
 * The three refusals stay apart because their remedies are opposite: nothing was built here, several
 * branches carry the child's commits and which one is the lane's is not derivable, or a ref this
 * tree cannot read — UNKNOWN, never "not built", since an operator standing in a checkout the epic
 * run never touched would otherwise read as a proof that the run did nothing.
 */
export type RangeLocation =
	| {readonly _tag: "Located"; readonly range: ChildRange; readonly notes: ReadonlyArray<string>}
	| {readonly _tag: "Absent"; readonly why: string; readonly notes: ReadonlyArray<string>}
	| {readonly _tag: "Ambiguous"; readonly why: string; readonly notes: ReadonlyArray<string>}
	| {readonly _tag: "Unreadable"; readonly what: string; readonly reason: string};

/**
 * Where `tip` left the assembly branch — the near end of the range its reviewer measured.
 *
 * Not `epic/<n>`'s tip. That tip moves under every child as its siblings land, and once this child's
 * own commits land on it the `epic/<n>..branch` range empties, which reads as "cut and never built
 * on" and deadlocks the lane (#5984). The fork point survives both: the commits stay the same
 * through the drift, and the diff the digest is taken over stays the diff the verdict was bound to
 * (ADR 0276), so `bindRange` still answers `Current` after integration.
 *
 * Two reads, because the merge base alone stops answering the moment the tip is contained in the
 * epic branch — it is then the tip itself. The second read recovers the epic branch as it stood
 * before the merge that brought the tip in, and takes the merge base against that.
 */
const forkPoint = (epicTip: string, tip: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const shared = yield* mergeBase(epicTip, tip);
		if (shared._tag === "Failure" || shared.value !== tip) return shared;
		const walked = yield* rangeParents(tip, epicTip);
		if (walked._tag === "Failure") return walked;
		const before = integratedFrom(tip, walked.value);
		// Nothing merged this tip in, so it is a commit of the assembly branch itself: it forked from
		// itself, the range is empty, and `traceRange` says cut-and-never-built-on in those words.
		if (before === null) return ok(tip);
		return yield* mergeBase(before, tip);
	});

export const locateRange = (
	verb: string,
	epic: number,
	issue: number,
): Effect.Effect<RangeLocation, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const baseRef = epicBranch(epic);
		const base = yield* resolveCommit(baseRef, " — the epic run's assembly branch");
		if (base._tag === "Failure") {
			return {_tag: "Unreadable" as const, what: `"${baseRef}" in this tree`, reason: base.reason};
		}
		const branches = yield* localBranches;
		if (branches._tag === "Failure") {
			return {
				_tag: "Unreadable" as const,
				what: "this tree's local branches",
				reason: branches.reason,
			};
		}
		const candidates = childLaneBranches(issue, branches.value);
		const facts: BranchFact[] = [];
		for (const branch of candidates) {
			const tip = yield* resolveCommit(branch);
			if (tip._tag === "Failure") {
				return {_tag: "Unreadable" as const, what: `branch "${branch}"`, reason: tip.reason};
			}
			const forked = yield* forkPoint(base.value, tip.value);
			if (forked._tag === "Failure") {
				return {
					_tag: "Unreadable" as const,
					what: `where "${branch}" forked from ${baseRef}`,
					reason: forked.reason,
				};
			}
			const walked = yield* rangeCommits(forked.value, tip.value);
			if (walked._tag === "Failure") {
				return {
					_tag: "Unreadable" as const,
					what: `the commits "${branch}" adds over ${forked.value}`,
					reason: walked.reason,
				};
			}
			facts.push({
				branch,
				base: forked.value,
				tip: tip.value,
				messages: walked.value.map((row) => row.message),
			});
		}

		const notes = [
			`${verb}: #${issue} is a child of epic #${epic} and opens no PR of its own — looked in this tree for a lane branch of #${issue} over ${baseRef}; ${branches.value.length} local branch(es) read, ${candidates.length} candidate(s).`,
		];
		const trace = traceRange(issue, baseRef, facts);
		if (trace._tag === "None") return {_tag: "Absent" as const, why: trace.why, notes};
		if (trace._tag === "Many") {
			return {
				_tag: "Ambiguous" as const,
				why: `${trace.branches.join(", ")} each carry commits naming #${issue} — which range this lane built is not derivable here`,
				notes,
			};
		}
		return {
			_tag: "Located" as const,
			range: {
				branch: trace.branch,
				base: trace.base,
				tip: trace.tip,
				commits: trace.commits,
				naming: trace.naming,
			},
			notes: [
				...notes,
				`${verb}: ${trace.branch} forked ${baseRef} at ${trace.base} and adds ${trace.commits} commit(s), ${trace.naming} of them naming #${issue}.`,
			],
		};
	});
