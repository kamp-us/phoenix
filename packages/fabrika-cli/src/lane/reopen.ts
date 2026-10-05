/**
 * Whether the board shows an issue reopened after its work landed — the one fact that lets a driver
 * set a `complete` lane aside (`lane archive --reopened`) and boot a second lane over the merged
 * closing pull request `lane open` otherwise refuses at 63.
 *
 * **The reopen is read, never declared.** Three facts off one board read, all of them required: the
 * issue is open; every pull request on its closing edge merged, so no lane's work is still in
 * flight; and the latest reopen on its timeline came after the last of those merges, so the issue
 * was reopened for new work rather than reopened before it ever landed. A pull request that closed
 * without merging is outside the judgement, as it is outside
 * [`prior-lane.ts`](prior-lane.ts)'s scope.
 *
 * An unreadable answer is `Unknown`, never `Reopened`: passing a failed read is the permissive arm
 * both refusals exist to close.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10317#issuecomment-5974128993
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {resolveRepo} from "../io/issues.ts";
import {issueReopenFacts, type ReopenFacts} from "../io/pulls.ts";

export type ReopenVerdict =
	/** Open, every closer merged, and reopened after the last merge — the second lane's warrant. */
	| {
			readonly _tag: "Reopened";
			readonly pulls: ReadonlyArray<number>;
			readonly landedAt: string;
			readonly reopenedAt: string;
	  }
	/** The board read, and it does not show a reopen after landing; `why` names the fact that failed. */
	| {readonly _tag: "NotReopened"; readonly why: string};

export type ReopenRead = ReopenVerdict | {readonly _tag: "Unknown"; readonly reason: string};

export type ReopenReader<R> = (issue: number) => Effect.Effect<ReopenRead, never, R>;

/** Judge one issue's board facts. Pure, so every arm is provable offline. */
export const judgeReopen = (issue: number, facts: ReopenFacts): ReopenVerdict => {
	if (facts.state !== "OPEN") {
		return {_tag: "NotReopened", why: `#${issue} is closed, so nothing reopened it`};
	}
	const open = facts.closers.filter((pull) => pull.state === "OPEN").map((pull) => pull.number);
	if (open.length > 0) {
		return {
			_tag: "NotReopened",
			why: `#${issue} has open closing pull request(s) ${open.map((n) => `#${n}`).join(", ")}, so a lane's work on it is still in flight`,
		};
	}
	const merged = facts.closers.filter((pull) => pull.state === "MERGED");
	if (merged.length === 0) {
		return {
			_tag: "NotReopened",
			why: `no merged pull request closes #${issue}, so no lane's work on it landed`,
		};
	}
	const times = merged.flatMap((pull) => (pull.mergedAt === null ? [] : [pull.mergedAt]));
	if (times.length !== merged.length) {
		return {
			_tag: "NotReopened",
			why: `a merged pull request closing #${issue} carries no merge time, so whether the reopen came after it is unproven`,
		};
	}
	const landedAt = times.reduce((latest, at) =>
		Date.parse(at) > Date.parse(latest) ? at : latest,
	);
	if (facts.reopenedAt === null) {
		return {_tag: "NotReopened", why: `the board shows no reopen on #${issue}`};
	}
	if (!(Date.parse(facts.reopenedAt) > Date.parse(landedAt))) {
		return {
			_tag: "NotReopened",
			why: `#${issue} was last reopened at ${facts.reopenedAt}, not after its last closing pull request merged at ${landedAt}`,
		};
	}
	return {
		_tag: "Reopened",
		pulls: merged.map((pull) => pull.number),
		landedAt,
		reopenedAt: facts.reopenedAt,
	};
};

/** The live reader, resolving the repo once, in the shape [`prior-lane.ts`](prior-lane.ts) established. */
export const reopenReader = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): ReopenReader<ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient> => {
	let resolved: string | null = null;
	return (issue) =>
		Effect.gen(function* () {
			if (resolved === null) {
				const attempt = yield* resolveRepo(repo, env);
				if (attempt._tag === "Failure") {
					return {
						_tag: "Unknown" as const,
						reason: "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name",
					};
				}
				resolved = attempt.value;
			}
			const facts = yield* issueReopenFacts(resolved, issue);
			if (facts._tag === "Failure") {
				return {
					_tag: "Unknown" as const,
					reason: `cannot read whether #${issue} was reopened after landing: ${facts.reason}`,
				};
			}
			return judgeReopen(issue, facts.value);
		});
};
