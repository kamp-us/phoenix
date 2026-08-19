/**
 * Which landing path a base branch has, and which method a direct landing may use.
 *
 * The fact is composed from **two** platform reads that live on different APIs — whether a merge
 * queue governs the branch, and which merge methods the repository permits — and neither read is
 * about the pull request. A shipper left to do that composition itself is the #6018 gap: `ship`
 * could arm a queue and nothing else, so a repo with no queue had `allow_auto_merge: false` and
 * `mergeQueue: null` sitting on two endpoints, with no verb reading either.
 *
 * The three paths are exclusive and each is a proven answer:
 *
 * - `queue` — a merge queue governs the branch, so the queue owns both the method and the landing
 *   (`ship enqueue`). The permitted-method read is skipped here, because it decides nothing.
 * - `direct` — no queue, and the repository permits at least one method (`ship merge`).
 * - `none` — no queue and no permitted method: nothing in this repository can land this branch, and
 *   that is a settings fact a human fixes, never a method to guess at.
 */
import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {isQueueGoverned} from "./github.ts";

/** The three values GitHub's merge endpoint accepts for `merge_method`. */
export type MergeMethod = "squash" | "merge" | "rebase";

export interface AllowedMethods {
	readonly squash: boolean;
	readonly merge: boolean;
	readonly rebase: boolean;
}

/**
 * Preference order for a direct landing, most preferred first.
 *
 * Squash leads because it is the only method whose default subject ends `(#<pr>)`, which is the
 * anchor `landedOnBase` in `./queue.ts` proves a landing with — a rebase landing publishes the
 * branch's own subjects and is invisible to that cross-check.
 */
export const METHOD_PREFERENCE: ReadonlyArray<MergeMethod> = ["squash", "merge", "rebase"];

export const preferredMethod = (allowed: AllowedMethods): MergeMethod | null =>
	METHOD_PREFERENCE.find((method) => allowed[method]) ?? null;

/** What the repository permits. An absent flag reads `false` — never a method assumed available. */
export const readAllowedMethods = (repo: string): Shell<Attempt<AllowedMethods>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}`]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		if (!isRecord(parsed)) return fail("`gh api` exited 0 but its output is not a repository");
		return ok({
			squash: parsed.allow_squash_merge === true,
			merge: parsed.allow_merge_commit === true,
			rebase: parsed.allow_rebase_merge === true,
		});
	});

export type LandingPath = "queue" | "direct" | "none";

export interface Landing {
	readonly path: LandingPath;
	/** The method a direct landing would use — `null` on `queue` (the queue owns it) and on `none`. */
	readonly method: MergeMethod | null;
}

export const landingOf = (queueGoverned: boolean, allowed: AllowedMethods | null): Landing => {
	if (queueGoverned) return {path: "queue", method: null};
	const method = allowed === null ? null : preferredMethod(allowed);
	return method === null ? {path: "none", method: null} : {path: "direct", method};
};

export const readLanding = (repo: string, base: string): Shell<Attempt<Landing>> =>
	Effect.gen(function* () {
		const governed = yield* isQueueGoverned(repo, base);
		if (governed._tag === "Failure") return governed;
		if (governed.value) return ok(landingOf(true, null));
		const allowed = yield* readAllowedMethods(repo);
		return allowed._tag === "Failure" ? allowed : ok(landingOf(false, allowed.value));
	});

/** What a landing must show to be proven: the flag and the commit it produced. */
export interface MergeProof {
	readonly merged: boolean;
	readonly mergeCommitSha: string;
}

const PROOF_FILTER = '{merged: .merged, commit: (.merge_commit_sha // "")}';

/**
 * Read the landing back off the pull request.
 *
 * Separate from `../io/pulls.ts`'s `PullRecord`, which carries `merged` and not the merge SHA: a
 * `merged: true` with no commit behind it is a claim with no evidence, and the pair is what makes
 * the landing falsifiable. The projection is asked for by name rather than filtered out of the full
 * payload, so the read that confirms the write is a different request from the read that resolved
 * the head — one endpoint answering two questions is one request nobody can tell apart in a log.
 */
export const readMergeProof = (repo: string, pr: number): Shell<Attempt<MergeProof>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/pulls/${pr}`, "--jq", PROOF_FILTER]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		if (!isRecord(parsed) || typeof parsed.commit !== "string") {
			return fail("`gh api` exited 0 but named no merge state");
		}
		return ok({merged: parsed.merged === true, mergeCommitSha: parsed.commit});
	});

/**
 * Land the pull request directly.
 *
 * `sha` is the **full** live head, not the caller's possibly-abbreviated `--sha`: the platform
 * compares it exactly and rejects the merge if the head moved, so it is the write's own drift guard
 * on top of the verb's. Its exit status is never the proof — the caller re-reads.
 */
export const mergePull = (
	repo: string,
	pr: number,
	sha: string,
	method: MergeMethod,
): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"PUT",
			`repos/${repo}/pulls/${pr}/merge`,
			"-f",
			`sha=${sha}`,
			"-f",
			`merge_method=${method}`,
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});
