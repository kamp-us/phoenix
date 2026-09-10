/**
 * What an epic run's assembly branch says has already landed.
 *
 * An epic run is one branch and one PR: a child's work is merged onto `epic/<N>` and its issue stays
 * open until the single tail PR merges. So inside a run in flight, "the predecessor's issue is
 * closed" answers a different question from "the predecessor's work landed", and only the second is
 * the one a dependency gate means.
 *
 * The evidence is the git graph, never the lane's own fold — a machine's self-report is not
 * evidence, which is why `lane prove` reads commits too.
 *
 * **A mention that is not a landing cannot discharge.** The rule is {@link landingRefsIn}, which
 * recognises only the three message shapes the pipeline writes onto an assembly branch — a subject's
 * trailing `(#<n>)`, a line-anchored closing trailer, and `lane integrate`'s
 * `Merge branch 'build/<n>-…'`. `issueRefsIn` matches a bare `#<n>` anywhere, so reading *it* as
 * evidence let `refactor(tracer): rework the helper; does not touch #<n>` discharge that number's
 * edge. Recognition runs one way only: a shape the rule does not know is no evidence, so the edge
 * keeps the board's state and the gate refuses.
 *
 * **The read is also the run's own commits, never everything reachable from the branch tip.** The
 * set is `<merge base with the trunk>..epic/<N>`, the two-dot shape `lane prove` locates a child's
 * range with. A one-dot walk sweeps in the whole trunk history the branch was cut from, where a
 * years-old commit closing its own `#<n>` would discharge an edge this run never built. The two
 * bounds are independent: the range says which commits may speak, the landing rule says what
 * counts as speaking.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {mergeBase, noMergeBaseReason, rangeCommits, resolveCommit} from "../io/git.ts";
import {epicBranch} from "../wire/lane-brief.ts";
import {landingRefsIn} from "./commit-message.ts";
import {defaultBranch} from "./github.ts";

/** Every issue number these commit messages claim to land — the set whose work this branch carries. */
export const landedRefs = (messages: ReadonlyArray<string>): ReadonlySet<number> =>
	new Set(messages.flatMap((message) => [...landingRefsIn(message)]));

/**
 * What the assembly branch said, or why it said nothing.
 *
 * `Unreadable` folds an absent branch, an unnameable trunk and a failed read together on purpose:
 * none is evidence that work landed, so all of them leave every edge exactly as the board reads it.
 * Discharge is the only direction this read may move an answer in.
 */
export type Assembly =
	| {
			readonly _tag: "Read";
			readonly branch: string;
			/** The trunk ref the range is bounded against, so a diagnostic names a range a human can re-run. */
			readonly baseRef: string;
			readonly landed: ReadonlySet<number>;
			/** How many commits the run put on the branch — not how many the branch can reach. */
			readonly commits: number;
	  }
	| {readonly _tag: "Unreadable"; readonly branch: string; readonly reason: string};

/**
 * Read epic `epic`'s assembly branch in this tree, bounded to the commits the run put on it.
 *
 * Both endpoints are derived, never taken from a caller: the branch name from the epic number
 * through {@link epicBranch}, the base from the repo's own default branch. A caller-named endpoint
 * is a caller-chosen answer to "has this landed".
 */
export const readAssembly = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	epic: number,
): Effect.Effect<
	Assembly,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const branch = epicBranch(epic);
		const tip = yield* resolveCommit(branch, " — the epic run's assembly branch");
		if (tip._tag === "Failure") return {_tag: "Unreadable" as const, branch, reason: tip.reason};
		const trunk = yield* defaultBranch(env, repo);
		if (trunk._tag === "Failure")
			return {
				_tag: "Unreadable" as const,
				branch,
				reason: `cannot name ${repo}'s default branch to bound the read against: ${trunk.reason}`,
			};
		const baseRef = `origin/${trunk.value}`;
		const base = yield* mergeBase(baseRef, tip.value);
		if (base._tag === "Failure")
			return {
				_tag: "Unreadable" as const,
				branch,
				reason: yield* noMergeBaseReason(baseRef, base.reason),
			};
		const walked = yield* rangeCommits(base.value, tip.value);
		if (walked._tag === "Failure")
			return {_tag: "Unreadable" as const, branch, reason: walked.reason};
		return {
			_tag: "Read" as const,
			branch,
			baseRef,
			landed: landedRefs(walked.value.map((commit) => commit.message)),
			commits: walked.value.length,
		};
	});
