/**
 * `lane retrigger` — schedule a fresh CI run on every open pull request sitting on an epic run's
 * assembly branch, after that branch has moved.
 *
 * The platform behaviour this exists for was read against a live pull request rather than assumed.
 * GitHub **does** recompute `refs/pull/<n>/merge` when the base moves: one open pull request's merge
 * ref, fetched while its head had not been pushed for eleven days, carried the trunk tip of that
 * morning as its first parent. What the base push does not do is emit any event — `pull_request`
 * fires on
 * `opened`, `synchronize` and `reopened`, and a base push is none of them
 * ([GitHub, "Events that trigger
 * workflows"](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request))
 * — so nothing schedules a run and the checks on that PR keep reporting a tree from before the base
 * moved. The same read showed it: every check run on that head was stamped the day the head was
 * pushed, with hundreds of trunk commits landed since.
 *
 * That rules out the two cheap levers. Re-requesting the check suite or re-running the workflow
 * replays the original event: "The workflow will also use the same `GITHUB_SHA` (commit SHA) and
 * `GITHUB_REF` (git ref) of the original event that triggered the workflow run"
 * ([GitHub, "Re-run workflows and
 * jobs"](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)),
 * which is the stale merge commit — the very red the driver is trying to clear. And close/reopen,
 * the hand fix this verb retires, tears the pull request's preview stage down mid-deploy.
 *
 * So the head has to move, and the smallest honest move is the platform's own branch update: it
 * merges the base into the head branch, which is a `synchronize`, which schedules a run against a
 * merge ref computed now. Nothing is closed, nothing is force-pushed and no commit of the child's
 * is rewritten.
 *
 * **Idempotent by construction.** A child whose head already contains the base tip is *not* stale —
 * its last run judged the tree the merge ref holds today — so it is read, reported `current` and
 * never written to. The staleness question is asked of the platform's own comparison, so a second
 * call right after a first one writes nothing.
 *
 * It touches no working tree and no lane record: the branch name is derived from the epic number
 * and everything else is the board's. Publishing the assembly branch stays `lane push`'s, and
 * recording anything stays the driver's.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8880
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber, resolveTargetRepo} from "../build/target.ts";
import type {Shell} from "../io/git.ts";
import {
	type BasePull,
	compareStanding,
	getPullRequest,
	openPullsForBase,
	updatePullBranch,
} from "../io/pulls.ts";
import {pollWaits} from "../ship/mergeability.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {epicBranch} from "../wire/lane-brief.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE, MERGE_CONFLICT} from "./codes.ts";

const VERB = "fabrika lane retrigger";

/** The whole wall-clock one accepted update gets to move the head before it is called UNKNOWN. */
export const RETRIGGER_WINDOW_SECONDS = 60;

/** How many characters of a sha a report prints — enough to identify, short enough to scan. */
const SHORT = 8;

const short = (sha: string): string => sha.slice(0, SHORT);

/**
 * What became of one child, as four facts rather than a boolean.
 *
 * `Current` and `Moved` are the two answers; `Conflicted` and `Unknown` are the two ways a child
 * ends a sweep unretriggered, and they are kept apart because their remedies are opposite — a
 * conflict is a repair round on that child, and an unknown is a re-read before anything else is
 * touched.
 *
 * `Moved` and `Unknown` each carry whether this verb wrote to that child, because the sweep's exit
 * code turns on whether *any* child was written to, and a child that ends unknown after a sibling's
 * head was already moved is not the untouched sweep exit `11` promises.
 */
type Outcome =
	| {readonly _tag: "Current"; readonly pr: number}
	| {
			readonly _tag: "Moved";
			readonly pr: number;
			readonly from: string;
			readonly to: string;
			/** How far the head trailed the base when this sweep read it, before the move. */
			readonly behindBy: number;
			readonly wrote: boolean;
	  }
	| {readonly _tag: "Conflicted"; readonly pr: number; readonly reason: string}
	| {
			readonly _tag: "Unknown";
			readonly pr: number;
			readonly reason: string;
			readonly wrote: boolean;
	  };

/** Whether this verb addressed a write to that child — `Current` and `Conflicted` never do. */
const wroteTo = (outcome: Outcome): boolean =>
	(outcome._tag === "Moved" || outcome._tag === "Unknown") && outcome.wrote;

/**
 * Watch one child's head until it leaves `from`, within the window.
 *
 * The update endpoint answers 202 and merges asynchronously, so the accepted status is a receipt
 * and not a landing. A head that has not moved when the window is spent is UNKNOWN rather than a
 * failure: the merge may still be in flight, and reporting it as not done would send a driver to
 * write again over a write that is already running.
 *
 * The first read costs no wait, because a small merge is routinely done before the first one would
 * elapse; the waits are {@link pollWaits}' schedule rather than a second one written here.
 */
const awaitMovedHead = (
	repo: string,
	pr: number,
	from: string,
	behindBy: number,
	windowSeconds: number,
): Shell<Outcome> =>
	Effect.gen(function* () {
		for (const wait of [0, ...pollWaits(windowSeconds)]) {
			if (wait > 0) yield* Effect.sleep(`${wait} seconds`);
			const read = yield* getPullRequest(repo, pr);
			if (read._tag === "Absent") {
				return {
					_tag: "Unknown" as const,
					pr,
					reason: "the pull request is no longer there to read back",
					wrote: true,
				};
			}
			if (read._tag === "Unknown")
				return {_tag: "Unknown" as const, pr, reason: read.reason, wrote: true};
			if (read.value.headSha !== from) {
				return {_tag: "Moved" as const, pr, from, to: read.value.headSha, behindBy, wrote: true};
			}
		}
		return {
			_tag: "Unknown" as const,
			pr,
			reason: `the update was accepted and the head was still ${short(from)} after ${windowSeconds}s`,
			wrote: true,
		};
	});

/**
 * One child, from the staleness read through to the head it ends on.
 *
 * The `Declined` arm re-reads the head because the platform spends one status on two facts: a
 * conflict and a head that moved since it was read both answer 422. A head that is no longer the
 * commit this sweep sent is the second of those, and it is not a failure at all — whatever moved it
 * emitted the `synchronize` this verb was going to buy.
 */
const retriggerOne = (
	repo: string,
	base: string,
	child: BasePull,
	windowSeconds: number,
): Shell<Outcome> =>
	Effect.gen(function* () {
		const standing = yield* compareStanding(repo, base, child.headSha);
		if (standing._tag === "Failure") {
			return {_tag: "Unknown" as const, pr: child.number, reason: standing.reason, wrote: false};
		}
		if (standing.value.status === "identical" || standing.value.status === "ahead") {
			return {_tag: "Current" as const, pr: child.number};
		}

		const update = yield* updatePullBranch(repo, child.number, child.headSha);
		if (update._tag === "Unreadable") {
			return {_tag: "Unknown" as const, pr: child.number, reason: update.reason, wrote: true};
		}
		if (update._tag === "Declined") {
			const read = yield* getPullRequest(repo, child.number);
			if (read._tag !== "Present") {
				return {
					_tag: "Unknown" as const,
					pr: child.number,
					reason: `${update.reason}, and the head could not be re-read to tell a conflict from a head that moved`,
					wrote: false,
				};
			}
			return read.value.headSha === child.headSha
				? {_tag: "Conflicted" as const, pr: child.number, reason: update.reason}
				: {
						_tag: "Moved" as const,
						pr: child.number,
						from: child.headSha,
						to: read.value.headSha,
						behindBy: standing.value.behindBy,
						wrote: false,
					};
		}
		return yield* awaitMovedHead(
			repo,
			child.number,
			child.headSha,
			standing.value.behindBy,
			windowSeconds,
		);
	});

const row = (outcome: Outcome): string => {
	switch (outcome._tag) {
		case "Current":
			return `#${outcome.pr} current`;
		case "Moved":
			return `#${outcome.pr} ${outcome.behindBy} behind, ${short(outcome.from)} -> ${short(outcome.to)}`;
		case "Conflicted":
			return `#${outcome.pr} conflicted`;
		case "Unknown":
			return `#${outcome.pr} unknown`;
	}
};

export interface RetriggerOptions {
	readonly epic: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The window one accepted update gets to move the head. Tests pass `0`; the adapter never does. */
	readonly windowSeconds?: number;
}

export const runRetrigger = ({
	epic,
	repo,
	env,
	windowSeconds = RETRIGGER_WINDOW_SECONDS,
}: RetriggerOptions): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "an issue number", epic);
		if (bad !== null) return bad;

		const target = yield* resolveTargetRepo(VERB, repo, env);
		if (target._tag === "Refused") return target.outcome;
		const base = epicBranch(epic);

		const listed = yield* openPullsForBase(target.repo, base);
		if (listed._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read the open pull requests based on ${base}: ${listed.reason} — which children are stale is UNKNOWN, so nothing was written.`,
			);
		}
		if (listed.value.length === 0) {
			return answer("RETRIGGER-VERDICT: NONE\n", [
				`${VERB}: no open pull request is based on ${base} — nothing was read further and nothing was written.`,
			]);
		}

		const outcomes: Outcome[] = [];
		for (const child of listed.value) {
			outcomes.push(yield* retriggerOne(target.repo, base, child, windowSeconds));
		}

		const moved = outcomes.filter((outcome) => outcome._tag === "Moved");
		const rows = outcomes.map(row).join("\n");
		const note = `${VERB}: ${moved.length} of ${outcomes.length} open pull request(s) on ${base} were behind it and were updated; the rest already carried it.`;

		// The code a driver reads to decide whether a re-run is safe, so it answers over the whole
		// sweep rather than over the child that ended unknown: one child read badly after a sibling's
		// head was already moved is an unknown with a write behind it, which is exit 8's fact, not
		// exit 11's.
		const unknown = outcomes.find((outcome) => outcome._tag === "Unknown");
		if (unknown !== undefined) {
			return refuse(
				outcomes.some(wroteTo) ? APPEND_UNKNOWN : LANE_UNREADABLE,
				`${VERB}: #${unknown.pr}: ${unknown.reason} — whether its checks were retriggered is UNKNOWN.`,
				[note, ...outcomes.map(row)],
			);
		}

		const conflicted = outcomes.filter((outcome) => outcome._tag === "Conflicted");
		if (conflicted.length > 0) {
			return refuse(
				MERGE_CONFLICT,
				`${VERB}: ${base} does not merge into ${conflicted.length} of these head branch(es), so their checks cannot be retriggered without a repair round: ${conflicted
					.map((outcome) => `#${outcome.pr} (${outcome.reason})`)
					.join("; ")}.`,
				[note, ...outcomes.map(row)],
			);
		}

		return answer(
			`${rows}\nRETRIGGER-VERDICT: ${moved.length === 0 ? "CURRENT" : "RETRIGGERED"}\n`,
			[note],
		);
	});
