/**
 * `ship floor-batch` — the `governance floor at head` context on a merge queue's batch ref.
 *
 * A required status check is demanded on the queue's batched `merge_group` ref, not only on the PR
 * ref, and a workflow only runs there if it carries a `merge_group:` trigger. `governance-floor.yml`
 * had `pull_request:` alone, so the moment the floor was added to the ruleset's required set the
 * batch could never carry the context and every queued merge hung toward the check timeout — the
 * repo-wide freeze of 2026-08-21 (#6968). ADR 0132 records the identical failure for `ci-required`.
 *
 * **The batch ref has nothing to re-derive, so this verb resolves no floor.** A `merge_group` ref is
 * not a pull request: it has no number, no changed-file list against a base a verdict was written
 * over, no comments and no reviews. `ship floor` reads all four, so on a batch it has no input at
 * all — the pass here is the absence of a question, not a question waved through.
 *
 * **What still holds the floor is the PR ref.** Each PR in a batch was floor-gated at its own head
 * by `ship floor --publish-check`, and `ship gate` — the single merge authority — refuses a
 * governance-root PR whose `governance` verdict is absent, stale or FAIL before `ship enqueue` is
 * ever reached. Nothing about that changes here; this verb only puts the context where the queue
 * looks for it.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, type VerbOutcome} from "../verb.ts";
import {type CheckPlan, publishFloorCheck} from "./floor-check.ts";
import {NAMESPACE} from "./floor-verb.ts";
import {inspectedSha, NULL_TOKEN, resolveTargetRepo} from "./target.ts";

const VERB = "ship floor-batch";

export interface FloorBatchOptions {
	/** The batch head — `github.event.merge_group.head_sha`, the commit that actually merges. */
	readonly sha: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The one plan this verb writes, as a value rather than a branch — there is no state to read, so a
 * conditional here could only be a second answer about a ref that carries no question.
 */
export const BATCH_PLAN: CheckPlan = {
	_tag: "Concluded",
	conclusion: "success",
	floor: "batch",
	title: "The floor is not owed on a batch ref",
	summary:
		"A merge queue batch ref is not a pull request — no number, no comments, no reviews — so there is no governance verdict on it to read and nothing for `ship floor` to resolve. Every pull request in this batch was floor-gated at its own head by the same check-run, and `ship gate` refuses to enqueue a governance-root PR whose governance verdict is absent, stale or FAIL. This row puts the required context where the queue looks for it; it discharges nothing (ADR 0132, #6968).",
};

export const runFloorBatch = (
	options: FloorBatchOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const bound = inspectedSha(VERB, options.sha);
		if (typeof bound !== "string") return bound;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const published = yield* publishFloorCheck(VERB, resolved.repo, bound, BATCH_PLAN, []);
		if (published._tag === "Refused") return published.outcome;
		const {written, rewritten} = published;

		const posted = `${VERB}: ${rewritten ? "rewrote" : "posted"} check-run ${written.id} at ${bound} — the batch carries the context; no floor was resolved on it.`;
		return answer(
			options.json
				? JSON.stringify({
						outcome: BATCH_PLAN.floor,
						sha: bound,
						namespace: NAMESPACE,
						state: null,
						checkRun: {
							id: written.id,
							name: written.name,
							status: written.status,
							conclusion: written.conclusion,
						},
					})
				: `check\t${written.status}\t${written.conclusion ?? NULL_TOKEN}\t${written.id}\nfloor\t${BATCH_PLAN.floor}\t${bound}\nns\t${NAMESPACE}\t${NULL_TOKEN}`,
			[posted],
		);
	});
