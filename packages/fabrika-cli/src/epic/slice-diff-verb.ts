/**
 * `epic slice-diff` — the unpushed commit's diff bytes, served from the local object store.
 *
 * The founder constraint this whole conductor rests on: slice review runs over the **unpushed local
 * commit** — no push, no CI dependency, no draft PR. So the evaluator's read path is this verb and
 * then judgment over the bytes; it reads, never runs, and never checks the head out (#4959, at slice
 * scope).
 *
 * **Completeness is the local object store's.** There is no API tier and no truncation window here —
 * the PR-shaped gap #4993 measures does not exist for a local read — so a commit that resolves is
 * served in full or the read fails as `11`. An empty diff is `7`, never an empty answer.
 *
 * The one guard exemption in the group: the **tree assertion only**. An evaluator holds no claim; it
 * reads, so requiring one would make an independent evaluator impossible.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber} from "../build/target.ts";
import {assertGround} from "../build/worktree.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {COMMIT_NOT_IN_GRAPH, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {resolveCommit, showDiff} from "./graph.ts";

const VERB = "epic slice-diff";

const HEX = /^[0-9a-f]{7,40}$/;

export interface SliceDiffOptions {
	readonly number: number;
	readonly commit: string;
}

export const runSliceDiff = (
	options: SliceDiffOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "an issue number", options.number);
		if (bad !== null) return bad;

		const commit = options.commit.trim();
		if (!HEX.test(commit)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --commit "${options.commit}" is not 7–40 lowercase hex.`,
			);
		}

		const tree = yield* assertGround(VERB, false);
		if (tree._tag === "Refused") return tree.outcome;

		const resolved = yield* resolveCommit(commit);
		if (resolved === null) {
			return refuse(
				COMMIT_NOT_IN_GRAPH,
				`${VERB}: ${commit} is not in this branch's local graph — nothing to serve.`,
			);
		}
		const diff = yield* showDiff(resolved);
		if (diff._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the local graph: ${diff.reason} — UNKNOWN.`,
			);
		}
		if (diff.value.trim() === "") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: ${commit} has an empty diff — nothing to review (ADR 0092).`,
			);
		}
		return answer(diff.value);
	});
