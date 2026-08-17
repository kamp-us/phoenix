/**
 * `lane brief` — the spawn prompt for one task's current leaf state, printed rather than composed.
 *
 * Every value is derived: the state from the fold, the shell from the format's routing table, the
 * issue and PR from the board, the rules from the format's own byte-fixed text. Nothing here is
 * authored per run, which is the point — a prompt a driver writes by hand is a prompt two drivers
 * write differently, and the "URLs, never restatements" rule is then enforced by nothing but care.
 *
 * The brief is a dispatch artifact, consumed in-session and never posted, so it is not leak-scanned.
 * It carries no path and no content — only URLs the board already published.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue, resolveRepo} from "../io/issues.ts";
import {openPullsTracing} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	artifactUrl,
	emit as emitBrief,
	type LaneBrief,
	shellOf,
	shellState,
} from "../wire/lane-brief.ts";
import {ISSUE_UNRESOLVED, LANE_UNREADABLE, NO_SHELL, PR_AMBIGUOUS, TASK_UNKNOWN} from "./codes.ts";
import {foldLog, resolveTask} from "./fold.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane brief";

export interface BriefOptions extends LaneRef {
	/** The task the brief serves; omittable exactly when the machine leaves no choice. */
	readonly task: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The issue a task drives: the number in an emitted epic lane's task name (`issue_<n>`), else the
 * lane id itself on a single-issue lane. `null` when neither carries one.
 */
const issueOf = (lane: string, task: string): number | null => {
	const named = /^issue_(\d+)$/.exec(task);
	if (named?.[1] !== undefined) return Number.parseInt(named[1], 10);
	return /^\d+$/.test(lane.trim()) ? Number.parseInt(lane.trim(), 10) : null;
};

export const runBrief = (
	options: BriefOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
		const fold = foldLog(loaded.lane, loaded.entries);
		if (fold._tag !== "Folded") return replayRefusal(VERB, loaded.logPath, fold);

		const resolved = resolveTask(loaded.lane, options.task);
		if (resolved._tag !== "Task") return refuse(TASK_UNKNOWN, `${VERB}: ${resolved.reason}.`);
		const task = resolved.taskId;
		const leaf = fold.states[task]?.type ?? "";
		const state = shellState(leaf);
		if (state === null) {
			return refuse(
				NO_SHELL,
				`${VERB}: task "${task}" is "${leaf}", which routes to no shell — act on that state, do not dispatch.`,
			);
		}
		const shell = shellOf(state);

		const notes = [`${VERB}: folded ${loaded.entries.length} event(s) from ${loaded.logPath}.`];
		const issue = issueOf(options.lane, task);
		if (issue === null) {
			return refuse(
				ISSUE_UNRESOLVED,
				`${VERB}: neither task "${task}" nor lane "${options.lane}" names an issue number.`,
				notes,
			);
		}

		const repo = yield* resolveRepo(options.repo, options.env);
		if (repo._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot resolve the repository: ${repo.reason} — the ground is UNKNOWN.`,
				notes,
			);
		}
		const record = yield* getIssue(repo.value, issue);
		if (record._tag === "Absent") {
			return refuse(
				ISSUE_UNRESOLVED,
				`${VERB}: issue #${issue} is proven absent or closed — there is no ground to brief.`,
				notes,
			);
		}
		if (record._tag === "Unknown") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read #${issue}: ${record.reason} — the ground is UNKNOWN.`,
				notes,
			);
		}
		const issueUrl = artifactUrl(record.value.url);
		if (issueUrl === null) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: the board published no URL for #${issue} — the ground is UNKNOWN.`,
				notes,
			);
		}

		const pulls = yield* openPullsTracing(repo.value, issue);
		if (pulls._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read the open PRs tracing to #${issue}: ${pulls.reason} — UNKNOWN.`,
				notes,
			);
		}
		const [only, ...rest] = pulls.value;
		if (rest.length > 0) {
			return refuse(
				PR_AMBIGUOUS,
				`${VERB}: ${pulls.value.length} open PRs trace to #${issue} — exactly one is the lane's, and which is not this verb's to guess.`,
				[...notes, `${VERB}: candidates: ${pulls.value.map((p) => `#${p.number}`).join(", ")}.`],
			);
		}
		if (only === undefined && state !== "build") {
			return refuse(
				PR_AMBIGUOUS,
				`${VERB}: no open PR traces to #${issue}, and a "${state}" shell has nothing to read without one.`,
				notes,
			);
		}
		const prUrl = only === undefined ? null : artifactUrl(only.url);
		if (only !== undefined && prUrl === null) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: the board published no URL for PR #${only.number} — the ground is UNKNOWN.`,
				notes,
			);
		}

		const brief: LaneBrief = {
			lane: options.lane,
			task,
			state,
			shell,
			issue: issueUrl,
			pr: prUrl,
		};
		return answer(emitBrief(brief), [
			...notes,
			`${VERB}: task "${task}" is "${state}" — brief the ${shell}.`,
		]);
	});
