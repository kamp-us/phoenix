/**
 * The one place a lane verb asks "which open PR is this issue's".
 *
 * Two nomination reads, unioned, because neither alone answers the question. The closing-issue edge
 * (`openPullsClosing`) is authoritative and lag-free but blind to `Part of #N`, the shape
 * `build --partial` emits and the shape a builder writes when it honestly declines to close its
 * issue; the search index sees any body but lags a fresh PR. Reading the edge first means a lagging
 * index can only fail to add a candidate, never hide the closing one.
 *
 * Both reads only nominate; the body's links decide, through `issueRefsOf` and the set membership
 * `tracePulls` applies (#6797). A candidate that has closed since it was nominated, or that only
 * mentions the number in prose, drops out here rather than counting — so unioning in the looser read
 * widens candidates without widening what counts.
 *
 * **Why it is shared rather than copied.** `lane prove` unioned both reads while `lane brief` read
 * the edge alone, so a `Part of #N` PR proved a `DONE`, folded the lane to `review`, and then had no
 * reviewer dispatchable against it — a park no event could clear, because the divergence was a
 * property of the artifact and restoring the state restored the wall (#6179). Two verbs answering
 * one question have to answer it from one nominator.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getPullRequest, openPullsClosing, searchOpenPulls} from "../io/pulls.ts";
import {issueRefsOf} from "../review/classes.ts";
import type {PullFact} from "./prove.ts";

/** One nominated PR, read off the board: the trace's facts plus the link a brief hands on. */
export interface NominatedPull extends PullFact {
	readonly htmlUrl: string;
}

export type Nomination =
	| {readonly _tag: "Nominated"; readonly pulls: ReadonlyArray<NominatedPull>}
	/** A read that did not answer — never an empty candidate set, which is a different fact. */
	| {readonly _tag: "Unreadable"; readonly what: string; readonly reason: string};

/** What the union searched, for a refusal that has to name its own scope rather than half of it. */
export const nominationScope = (issue: number): string =>
	`the closing-issue edge and the open PRs whose body names #${issue}`;

export const nominateOpenPulls = (
	repo: string,
	issue: number,
): Effect.Effect<Nomination, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const closing = yield* openPullsClosing(repo, issue);
		if (closing._tag === "Failure") {
			return {
				_tag: "Unreadable" as const,
				what: `the open pull requests closing #${issue}`,
				reason: closing.reason,
			};
		}
		const found = yield* searchOpenPulls(repo, [`${issue}`, "in:body"]);
		if (found._tag === "Failure") {
			return {
				_tag: "Unreadable" as const,
				what: `the open pull requests mentioning #${issue}`,
				reason: found.reason,
			};
		}
		const candidates = new Set([...closing.value.map((pull) => pull.number), ...found.value]);
		const pulls: NominatedPull[] = [];
		for (const candidate of candidates) {
			const pull = yield* getPullRequest(repo, candidate);
			if (pull._tag === "Unknown") {
				return {_tag: "Unreadable" as const, what: `PR #${candidate}`, reason: pull.reason};
			}
			if (pull._tag === "Absent") continue;
			pulls.push({
				number: pull.value.number,
				open: pull.value.state === "open",
				linkedIssues: issueRefsOf(pull.value.body).numbers,
				htmlUrl: pull.value.htmlUrl,
			});
		}
		return {_tag: "Nominated" as const, pulls};
	});
