/**
 * `ship merge` — land a PR on a base branch no merge queue governs, and prove the landing.
 *
 * **The second landing path, not a flag on the first.** `ship enqueue` carries no merge-method flag
 * by construction, because a method alongside the queue arm conflicts with the queue and no-ops the
 * enqueue silently at exit 0. That argument is about a queue-governed base and says nothing about a
 * base with no queue — where, before this verb, `ship` could land nothing at all (#6018). So the
 * method surface lives here, on the path where the queue is *proven absent*, and `ship enqueue`
 * still has none.
 *
 * The queue check is a refusal and never a fallback: a base a queue governs is `ship enqueue`'s, and
 * a direct merge into it walks straight past the gate the queue exists to run. An unreadable queue
 * regime refuses too — this verb never lands on a base whose regime it could not read.
 *
 * The method is read off the repository, never guessed. A repo permitting none of the three refuses
 * on `19` rather than sending the platform a method it will reject.
 *
 * The write is proved the way the arm is: `merged` **and** the merge commit read back off the PR
 * after the call, because the merge call's own response is a claim and not evidence.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	NO_LANDING_METHOD,
	PRECONDITION_UNKNOWN,
	PROVEN_NOT_IN_STATE,
	READBACK_MISMATCH,
	STALE_HEAD,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {mergePull, readLanding, readMergeProof} from "./landing.ts";
import {readDefiniteMergeability} from "./mergeability.ts";
import {
	badNumber,
	inspectedSha,
	NULL_TOKEN,
	prefixMatch,
	resolvePull,
	resolveTargetRepo,
} from "./target.ts";

const VERB = "ship merge";

export interface MergeOptions {
	readonly pr: number;
	readonly sha: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runMerge = (
	options: MergeOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;
		const bound = inspectedSha(VERB, options.sha);
		if (typeof bound !== "string") return bound;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* resolvePull(VERB, repo, pr, {
			closedReason: "nothing to merge.",
			mergedReason: "nothing to merge.",
			unknownMessage: (reason) =>
				`${VERB}: cannot read #${pr}'s live head: ${reason} — nothing was merged.`,
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;
		if (!prefixMatch(pull.headSha, bound)) {
			return refuse(
				STALE_HEAD,
				`${VERB}: the live head is ${pull.headSha}, gates ran at ${bound} — refusing to merge a tree nobody verified.`,
			);
		}

		const landing = yield* readLanding(repo, pull.baseRef, options.env);
		if (landing._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${pull.baseRef}'s landing path: ${landing.reason} — nothing was merged.`,
			);
		}
		if (landing.value.path === "queue") {
			return refuse(
				PROVEN_NOT_IN_STATE,
				`${VERB}: a merge queue governs ${pull.baseRef} — the queue owns the method and the landing; run \`fabrika ship enqueue\` instead.`,
			);
		}
		const method = landing.value.method;
		if (method === null) {
			return refuse(
				NO_LANDING_METHOD,
				`${VERB}: ${repo} permits no merge method — squash, merge-commit and rebase are all disabled, so nothing can land on ${pull.baseRef}; a human enables one in the repository settings.`,
			);
		}
		const diagnostics = [
			`${VERB}: ${pull.baseRef} is not queue-governed and ${repo} permits ${method} — landing directly.`,
		];

		const mergeability = yield* readDefiniteMergeability(repo, pr);
		if (mergeability._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${pr}'s mergeability: ${mergeability.reason} — nothing was merged.`,
				diagnostics,
			);
		}
		if (mergeability._tag === "Indefinite") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: #${pr}'s mergeable_state is still indefinite after ${mergeability.polls} polls — mergeability is UNKNOWN, never green; nothing was merged.`,
				diagnostics,
			);
		}
		// Unlike the queue arm, which leaves a definite `dirty` to the platform, the direct merge acts
		// on it here: the endpoint would reject the call and that rejection is indistinguishable from a
		// write whose outcome nobody knows.
		if (!mergeability.value.mergeable) {
			return refuse(
				PROVEN_NOT_IN_STATE,
				`${VERB}: #${pr} is not mergeable (mergeable_state: ${mergeability.value.state}) — a definite read; nothing was merged.`,
				diagnostics,
			);
		}
		diagnostics.push(
			`${VERB}: mergeable_state is ${mergeability.value.state} (mergeable: true) — a definite read; merging.`,
		);

		const written = yield* mergePull(repo, pr, pull.headSha, method, options.env);
		if (written._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the merge failed: "${written.reason}" — whether #${pr} landed is UNKNOWN; re-read the PR before stopping.`,
				diagnostics,
			);
		}

		const proof = yield* readMergeProof(repo, pr, options.env);
		if (proof._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the merge was sent and the confirming read-back failed: ${proof.reason} — whether #${pr} landed is UNKNOWN; re-read the PR before stopping.`,
				diagnostics,
			);
		}
		const commit = proof.value.mergeCommitSha;
		if (!proof.value.merged || commit === "") {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the merge was sent and the read-back shows merged: ${String(proof.value.merged)} at merge commit ${commit === "" ? NULL_TOKEN : commit} — the landing is not proven.`,
				diagnostics,
			);
		}

		return json
			? answer(
					JSON.stringify({outcome: "merged", sha: bound, method, mergeCommit: commit}),
					diagnostics,
				)
			: answer(`merged\t${commit}\t${method}`, diagnostics);
	});
