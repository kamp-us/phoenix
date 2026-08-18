/**
 * `lane brief` — the spawn prompt for one task's current leaf state, printed rather than composed.
 *
 * Every value is derived: the state from the fold, the shell from the format's routing table, the
 * issue and PR from the board, the rules from the format's own byte-fixed text. Nothing here is
 * authored per run, which is the point — a prompt a driver writes by hand is a prompt two drivers
 * write differently, and the "URLs, never restatements" rule is then enforced by nothing but care.
 *
 * The brief is a dispatch artifact, consumed in-session and never posted, so it is not leak-scanned.
 * It carries no path and no content — only URLs the board already published, and the epic branch the
 * emitter's own shape names.
 *
 * An epic lane's children are the one place where no PR is resolved at all: one run is one branch and
 * one PR, so a child builds in a worktree and its review judges a commit range, while the tail task
 * briefs that single PR under the same refusals a single-issue lane has always used (ADR 0285).
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue, resolveRepo} from "../io/issues.ts";
import {openPullsClosing} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	type ArtifactUrl,
	artifactUrl,
	emit as emitBrief,
	epicBranch,
	type LaneBrief,
	type LaneGround,
	shellOf,
	shellState,
} from "../wire/lane-brief.ts";
import {ISSUE_UNRESOLVED, LANE_UNREADABLE, NO_SHELL, PR_AMBIGUOUS, TASK_UNKNOWN} from "./codes.ts";
import {foldLog, resolveTask} from "./fold.ts";
import {epicOf, issueOf} from "./prove.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane brief";

export interface BriefOptions extends LaneRef {
	/** The task the brief serves; omittable exactly when the machine leaves no choice. */
	readonly task: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

type UrlRead =
	| {readonly _tag: "Url"; readonly url: ArtifactUrl}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/** One issue's published URL, or the refusal that stands in its place — proven absent vs UNKNOWN. */
const issueUrl = (
	verb: string,
	repo: string,
	number: number,
	notes: ReadonlyArray<string>,
): Effect.Effect<UrlRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const record = yield* getIssue(repo, number);
		if (record._tag === "Absent") {
			return {
				_tag: "Refused",
				outcome: refuse(
					ISSUE_UNRESOLVED,
					`${verb}: issue #${number} is proven absent or closed — there is no ground to brief.`,
					notes,
				),
			} as const;
		}
		if (record._tag === "Unknown") {
			return {
				_tag: "Refused",
				outcome: refuse(
					LANE_UNREADABLE,
					`${verb}: cannot read #${number}: ${record.reason} — the ground is UNKNOWN.`,
					notes,
				),
			} as const;
		}
		const url = artifactUrl(record.value.url);
		return url === null
			? ({
					_tag: "Refused",
					outcome: refuse(
						LANE_UNREADABLE,
						`${verb}: the board published no URL for #${number} — the ground is UNKNOWN.`,
						notes,
					),
				} as const)
			: ({_tag: "Url", url} as const);
	});

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
		const issue = issueOf(task, options.lane);
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
		const read = yield* issueUrl(VERB, repo.value, issue, notes);
		if (read._tag === "Refused") return read.outcome;

		const epic = epicOf(Object.keys(loaded.lane.tasks));
		if (epic !== null && task !== `epic_${epic}`) {
			if (state === "ship") {
				return refuse(
					NO_SHELL,
					`${VERB}: task "${task}" is a child region of epic #${epic}, which has no ship state — an epic run merges once, at its tail.`,
					notes,
				);
			}
			const epicRead = yield* issueUrl(VERB, repo.value, epic, notes);
			if (epicRead._tag === "Refused") return epicRead.outcome;
			const ground: LaneGround = {
				_tag: "Epic",
				epic: epicRead.url,
				branch: epicBranch(epic),
			};
			const brief: LaneBrief = {lane: options.lane, task, state, shell, issue: read.url, ground};
			return answer(emitBrief(brief), [
				...notes,
				`${VERB}: task "${task}" is "${state}" on epic #${epic}'s lane — brief the ${shell}; a child state has no PR.`,
			]);
		}

		const pulls = yield* openPullsClosing(repo.value, issue);
		if (pulls._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read the open PRs declaring they close #${issue}: ${pulls.reason} — UNKNOWN.`,
				notes,
			);
		}
		const [only, ...rest] = pulls.value;
		if (rest.length > 0) {
			return refuse(
				PR_AMBIGUOUS,
				`${VERB}: ${pulls.value.length} open PRs declare they close #${issue} — exactly one is the lane's, and which is not this verb's to guess.`,
				[...notes, `${VERB}: candidates: ${pulls.value.map((p) => `#${p.number}`).join(", ")}.`],
			);
		}
		if (only === undefined && state !== "build") {
			return refuse(
				PR_AMBIGUOUS,
				`${VERB}: no open PR declares it closes #${issue}, and a "${state}" shell has nothing to read without one.`,
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

		// The epic run's tail (task `epic_<n>`, and a PR is resolved — the tail states require one
		// above): the ground carries the epic too, so the tail review's brief names where each
		// child's `build-deviations` disclosure lives (#5903).
		const ground: LaneGround =
			epic !== null && prUrl !== null && state !== "build"
				? {_tag: "Tail", pr: prUrl, epic: read.url}
				: {_tag: "Pull", pr: prUrl};
		const brief: LaneBrief = {
			lane: options.lane,
			task,
			state,
			shell,
			issue: read.url,
			ground,
		};
		return answer(emitBrief(brief), [
			...notes,
			`${VERB}: task "${task}" is "${state}" — brief the ${shell}.`,
		]);
	});
