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
import {localBranches, rangeCommits, resolveCommit} from "../io/git.ts";
import {epicBranch} from "../wire/lane-brief.ts";
import {type BranchFact, childLaneBranches, traceRange} from "./prove.ts";

/** The located range: the branch it was read off, and the two commits that bound it. */
export interface ChildRange {
	readonly branch: string;
	/** The epic branch's own ref name, so a diagnostic names a range a human can re-run. */
	readonly baseRef: string;
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
			const walked = yield* rangeCommits(base.value, tip.value);
			if (walked._tag === "Failure") {
				return {
					_tag: "Unreadable" as const,
					what: `the commits "${branch}" adds over ${baseRef}`,
					reason: walked.reason,
				};
			}
			facts.push({branch, tip: tip.value, messages: walked.value.map((row) => row.message)});
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
				baseRef,
				base: base.value,
				tip: trace.tip,
				commits: trace.commits,
				naming: trace.naming,
			},
			notes: [
				...notes,
				`${verb}: ${baseRef}..${trace.branch} adds ${trace.commits} commit(s), ${trace.naming} of them naming #${issue}.`,
			],
		};
	});
