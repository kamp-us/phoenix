/**
 * What an epic run's assembly branch says has already landed.
 *
 * Under ADR 0285 an epic run is one branch and one PR: a child's work is merged onto `epic/<N>` and
 * its issue stays open until the single tail PR merges (ADR 0131). So inside a run in flight, "the
 * predecessor's issue is closed" answers a different question from "the predecessor's work landed",
 * and only the second is the one a dependency gate means (#6063).
 *
 * The evidence is the git graph, never the lane's own fold — a machine's self-report is not evidence
 * (ADR 0283), which is why `lane prove` reads commits too. The ref-matching rule is
 * {@link issueRefsIn}, the same one `build commit` and `lane prove` read messages with, so a
 * predecessor cannot be discharged here by a spelling nothing else recognises.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {reachableCommits, resolveCommit} from "../io/git.ts";
import {epicBranch} from "../wire/lane-brief.ts";
import {issueRefsIn} from "./commit-message.ts";

/** Every issue number these commit messages name — the set whose work this branch carries. */
export const landedRefs = (messages: ReadonlyArray<string>): ReadonlySet<number> =>
	new Set(messages.flatMap((message) => [...issueRefsIn(message)]));

/**
 * What the assembly branch said, or why it said nothing.
 *
 * `Unreadable` folds an absent branch together with a failed read on purpose: neither is evidence
 * that work landed, so both leave every edge exactly as the board reads it. Discharge is the only
 * direction this read may move an answer in.
 */
export type Assembly =
	| {
			readonly _tag: "Read";
			readonly branch: string;
			readonly landed: ReadonlySet<number>;
			readonly commits: number;
	  }
	| {readonly _tag: "Unreadable"; readonly branch: string; readonly reason: string};

/**
 * Read epic `epic`'s assembly branch in this tree.
 *
 * The branch name is derived from the epic number through {@link epicBranch} and never taken from a
 * caller: a caller-named branch is a caller-chosen answer to "has this landed".
 */
export const readAssembly = (
	epic: number,
): Effect.Effect<Assembly, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const branch = epicBranch(epic);
		const tip = yield* resolveCommit(branch, " — the epic run's assembly branch");
		if (tip._tag === "Failure") return {_tag: "Unreadable" as const, branch, reason: tip.reason};
		const walked = yield* reachableCommits(tip.value);
		if (walked._tag === "Failure")
			return {_tag: "Unreadable" as const, branch, reason: walked.reason};
		return {
			_tag: "Read" as const,
			branch,
			landed: landedRefs(walked.value.map((commit) => commit.message)),
			commits: walked.value.length,
		};
	});
