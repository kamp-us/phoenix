/**
 * The one place a lane verb asks "which PR is this issue's".
 *
 * Two nomination reads, unioned, because neither alone answers the question. The closing-issue edge
 * (`pullsClosing`) is authoritative and lag-free but blind to `Part of #N`, the shape
 * `build --partial` emits and the shape a builder writes when it honestly declines to close its
 * issue; the search index sees any body but lags a fresh PR. Reading the edge first means a lagging
 * index can only fail to add a candidate, never hide the closing one.
 *
 * Both reads only nominate; the body's links decide, through `issueRefsOf` and the set membership
 * `tracePulls` applies (#6797). A candidate outside the caller's `PullScope`, or one that only
 * mentions the number in prose, drops out there rather than counting — so unioning in the looser read
 * widens candidates without widening what counts.
 *
 * `issueRefsOf` answers with a *kind* beside the numbers, and this module carries it rather than
 * dropping it: a merged PR that closed its issue and one that carried `Part of #N` are the same
 * merge to every reader that keeps only the numbers, which is how a partial ship folded its lane to
 * a terminal over an issue still open and still buildable (#7382). `traceClosure` in `./prove.ts`
 * is the one reader of that field, and every *nominated* fact carries it from here so the question
 * keeps one nominator. One other path feeds that reader, and it nominates nothing: `./closure.ts`
 * builds the field off the single PR a recorded ship line names, because a merged `Part of #N` is
 * invisible to both reads above and that is the case the read exists for (#7457).
 *
 * **Why it is shared rather than copied.** `lane prove` unioned both reads while `lane brief` read
 * the edge alone, so a `Part of #N` PR proved a `DONE`, folded the lane to `review`, and then had no
 * reviewer dispatchable against it — a park no event could clear, because the divergence was a
 * property of the artifact and restoring the state restored the wall (#6179). Two verbs answering
 * one question have to answer it from one nominator.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getPullRequest, type PullScope, pullsClosing, searchOpenPulls} from "../io/pulls.ts";
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
export const nominationScope = (issue: number, scope: PullScope = "open"): string =>
	`the ${scope === "open" ? "" : "open-or-merged "}closing-issue edge and the open PRs whose body names #${issue}`;

/**
 * Nominate this issue's pull requests. `scope` widens the closing edge alone, and deliberately: the
 * search half is the `Part of #N` reader and GitHub's index has no merged-PR question to ask that
 * the edge does not answer better, so widening it would add stale candidates without adding the one
 * candidate a wider caller is after — the merged PR that closed the issue (#6717).
 */
export const nominatePulls = (
	repo: string,
	issue: number,
	scope: PullScope = "open",
): Effect.Effect<Nomination, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const closing = yield* pullsClosing(repo, issue, scope);
		if (closing._tag === "Failure") {
			return {
				_tag: "Unreadable" as const,
				what: `the ${scope === "open" ? "open " : ""}pull requests closing #${issue}`,
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
			const refs = issueRefsOf(pull.value.body);
			pulls.push({
				number: pull.value.number,
				open: pull.value.state === "open",
				merged: pull.value.merged,
				linkedIssues: refs.numbers,
				linkKind: refs.kind,
				htmlUrl: pull.value.htmlUrl,
			});
		}
		return {_tag: "Nominated" as const, pulls};
	});
