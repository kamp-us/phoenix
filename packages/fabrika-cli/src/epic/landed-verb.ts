/**
 * `epic landed` — prove a slice's commit landed, from the graph alone.
 *
 * The #4934 ruling's second duty, verbatim: read the graph, never the report. Three assertions, each
 * from git state — **HEAD moved** since the slice's opening SHA, **the old tip is an ancestor** of
 * the new HEAD (history extended, not rewritten), and **the tree is clean** beside it — plus a
 * non-empty commit, because an empty commit lands nothing.
 *
 * This is what makes a **dead dispatch a proven fact rather than an inferred one**: exit `22` after a
 * subagent returned is positive evidence the dispatch produced nothing. Both classes land here — the
 * silent green (`eval/spawn.ts`: exit 0, zero turns, nothing anywhere) and the produced-nothing
 * return — and the conductor records `dispatch-dead` on it. A rewritten history is `10`: off the
 * run's vocabulary entirely, and a human decides.
 */
import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {headSha, isAncestor} from "../build/git.ts";
import {badNumber} from "../build/target.ts";
import {uncommittedChanges} from "../build/worktree.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {DIRTY_TREE, NO_COMMIT, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {changedIn, firstParent} from "./graph.ts";
import {forSlice} from "./ledger.ts";
import {laneGround, loadRun} from "./run.ts";

const VERB = "epic landed";

/** How the refusals abbreviate a SHA — the length git itself abbreviates to in a log. */
const short = (sha: string): string => sha.slice(0, 8);

export interface LandedOptions {
	readonly number: number;
	readonly slice: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runLanded = (
	options: LandedOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const epic = options.number;
		const bad = badNumber(VERB, "an issue number", epic);
		if (bad !== null) return bad;

		const ground = yield* laneGround(VERB, epic, null, options.env);
		if (ground._tag === "Refused") return ground.outcome;

		const run = yield* loadRun(VERB, epic, ground);
		if (run._tag === "Refused") return run.outcome;

		const slice = options.slice;
		if (!run.plan.slices.some((row) => row.id === slice)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: slice "${slice}" is not in run ${run.plan.run}.`,
				ground.notes,
			);
		}
		const opening =
			forSlice(run.lines, slice)
				.filter((line) => line.event === "slice-dispatched")
				.at(-1)?.sha ?? null;
		if (opening === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: slice "${slice}" has no slice-dispatched on record — there is no opening SHA to prove a landing against.`,
				ground.notes,
			);
		}

		const head = yield* headSha;
		if (head._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read HEAD: ${head.reason} — the landing is UNKNOWN.`,
				ground.notes,
			);
		}
		if (head.value === opening) {
			return refuse(
				NO_COMMIT,
				`${VERB}: HEAD is unchanged since slice "${slice}" opened (${short(opening)}) — no commit landed; the dispatch is dead, not the slice failed.`,
				ground.notes,
			);
		}
		if (!(yield* isAncestor(opening, head.value))) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: ${short(opening)} is not an ancestor of HEAD — history was rewritten under this run; a human decides.`,
				ground.notes,
			);
		}

		const dirty = yield* uncommittedChanges;
		if (dirty._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the tree's status: ${dirty.reason} — cleanliness is UNKNOWN, never clean.`,
				ground.notes,
			);
		}
		if (dirty.value > 0) {
			return refuse(
				DIRTY_TREE,
				`${VERB}: the tree is dirty beside the new commit — an unfinished landing is not a landing.`,
				ground.notes,
			);
		}

		const files = yield* changedIn(head.value);
		if (files._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the commit's changed files: ${files.reason} — the landing is UNKNOWN.`,
				ground.notes,
			);
		}
		if (files.value.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: the new commit changes zero files — an empty commit lands nothing.`,
				ground.notes,
			);
		}

		const parent = yield* firstParent(head.value);
		return answer(
			JSON.stringify({
				answer: "landed",
				slice,
				commit: head.value,
				parent,
				files: files.value.length,
			}),
			ground.notes,
		);
	});
