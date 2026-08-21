/**
 * `lane brief` — the spawn prompt for one task's current leaf state, printed rather than composed.
 *
 * Every value is derived: the state from the fold, the shell from the format's routing table, the
 * issue and PR from the board, the rules from the format's own byte-fixed text. Nothing here is
 * authored per run, which is the point — a prompt a driver writes by hand is a prompt two drivers
 * write differently, and the "URLs, never restatements" rule is then enforced by nothing but care.
 *
 * The brief is a dispatch artifact, consumed in-session and never posted, so it is not leak-scanned.
 * It carries no content — only URLs the board already published, the epic branch the emitter's own
 * shape names, and the two local paths a spawned shell cannot derive: this driver's lanes root,
 * resolved absolute here because the shell would resolve a relative one against its own worktree,
 * and the fabrika entrypoint the shell runs its verbs through, resolved off this running copy so a
 * repo that installs fabrika is not handed phoenix's in-tree path (#6012).
 *
 * An epic lane's children are the one place where no PR is resolved at all: one run is one branch and
 * one PR, so a child builds in a worktree and its review judges a commit range, while the tail task
 * briefs that single PR under the same refusals a single-issue lane has always used (ADR 0285). That
 * range is resolved here, off this tree, through the same read `lane prove` stands its proof on
 * (`./range.ts`) — the two verbs cannot name different ranges for one child, and a range the tree
 * cannot pin refuses the dispatch instead of printing one that resolves to nothing (#6023).
 */
import {Effect, type FileSystem, Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import type {EntrypointRead} from "../delegate/entrypoint.ts";
import {getIssue, resolveRepo} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	type ArtifactUrl,
	artifactUrl,
	emit as emitBrief,
	epicBranch,
	fabrikaEntry,
	isBuildState,
	isReviewState,
	type LaneBrief,
	type LaneGround,
	lanesRoot,
	type ShellState,
	shellOf,
	shellState,
} from "../wire/lane-brief.ts";
import {headSha} from "../wire/marker-line.ts";
import {
	ISSUE_UNRESOLVED,
	LANE_UNREADABLE,
	NO_SHELL,
	PR_AMBIGUOUS,
	PROOF_ABSENT,
	PROOF_AMBIGUOUS,
	TASK_UNKNOWN,
} from "./codes.ts";
import {foldLog, resolveTask} from "./fold.ts";
import {nominateOpenPulls, nominationScope} from "./nominate.ts";
import {epicOf, issueOf, tracePulls} from "./prove.ts";
import {DEEPEN_REMEDY, locateRange, type RangeLocation} from "./range.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane brief";

export interface BriefOptions extends LaneRef {
	/** The task the brief serves; omittable exactly when the machine leaves no choice. */
	readonly task: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/**
	 * This run's own entrypoint, read at the command boundary off the real filesystem — the value the
	 * brief's `fabrika:` field carries, so the shell runs the copy of fabrika its repo actually has
	 * rather than phoenix's in-tree path (#6012).
	 */
	readonly entrypoint: EntrypointRead;
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

/**
 * A range this tree could not pin, seated on the proof codes the `lane` table already spends on
 * exactly these facts (`./codes.ts`) — nothing there, several candidates, unreadable, truncated.
 *
 * Refusing is the whole point: a brief whose range resolves to nothing sends the reviewer an empty
 * diff it can still land a `range-verdict-marker` over (#6023), and one whose base sits on a shallow
 * graft boundary sends it a count that swallowed everyone else's landed commits (#6343).
 */
const rangeRefusal = (
	located: Exclude<RangeLocation, {readonly _tag: "Located"}>,
	notes: ReadonlyArray<string>,
): VerbOutcome => {
	if (located._tag === "Truncated") {
		return refuse(
			LANE_UNREADABLE,
			`${VERB}: ${located.what} (${located.sha}) sits on this shallow clone's graft boundary, so every ancestry answer over it is wrong — which range the reviewer would judge is UNKNOWN. Remedy: ${DEEPEN_REMEDY}.`,
			notes,
		);
	}
	return located._tag === "Unreadable"
		? refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read ${located.what}: ${located.reason} — which range the reviewer would judge is UNKNOWN.`,
				notes,
			)
		: refuse(
				located._tag === "Absent" ? PROOF_ABSENT : PROOF_AMBIGUOUS,
				`${VERB}: ${located.why} — the reviewer would be sent to a range that resolves to nothing.`,
				[...notes, ...located.notes],
			);
};

type GroundRead =
	| {readonly _tag: "Ground"; readonly ground: LaneGround; readonly notes: ReadonlyArray<string>}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * A child state's ground: the epic issue and the assembly branch its worktree is cut from, plus —
 * at `review` only — the one range this tree resolved for the child.
 *
 * The range is read here so the reviewer judges two commits the *driver* pinned. The far end used to
 * be `HEAD`, which the spawned shell re-resolved in a worktree standing on the assembly branch, so
 * the range read as empty (#6023). `build` reads nothing off the tree at all: no child branch exists
 * yet there, and its ground carries no range field to half-fill.
 */
const childGround = (
	epic: number,
	epicUrl: ArtifactUrl,
	state: ShellState,
	issue: number,
	notes: ReadonlyArray<string>,
): Effect.Effect<GroundRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const branch = epicBranch(epic);
		if (!isReviewState(state)) {
			return {_tag: "Ground", ground: {_tag: "Epic", epic: epicUrl, branch}, notes: []} as const;
		}
		const located = yield* locateRange(VERB, epic, issue);
		if (located._tag !== "Located") {
			return {_tag: "Refused", outcome: rangeRefusal(located, notes)} as const;
		}
		const base = headSha(located.range.base);
		const tip = headSha(located.range.tip);
		if (base === null || tip === null) {
			return {
				_tag: "Refused",
				outcome: refuse(
					LANE_UNREADABLE,
					`${VERB}: this tree named "${located.range.base}..${located.range.tip}" for #${issue}, which is not a pair of revisions — the range is UNKNOWN.`,
					[...notes, ...located.notes],
				),
			} as const;
		}
		return {
			_tag: "Ground",
			ground: {_tag: "EpicRange", epic: epicUrl, branch, range: {base, tip}},
			notes: located.notes,
		} as const;
	});

export const runBrief = (
	options: BriefOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		// The brief carries the driver's root resolved against the driver's cwd, because the shell
		// resolves what it is handed against its own worktree (#5736).
		const root = lanesRoot(path.resolve(options.root));
		if (root === null) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: "${options.root}" does not resolve to an absolute lanes root — the shell would have nowhere to record.`,
			);
		}
		// The entrypoint rides as a `## Task` field and never as text inside the rules: the format's
		// reader recomputes those bytes from the ground alone, so an interpolated path would make
		// every brief malformed on the next machine that read it (#6012).
		const entry = options.entrypoint;
		const fabrika = entry._tag === "Entrypoint" ? fabrikaEntry(entry.entrypoint) : null;
		if (fabrika === null) {
			const why =
				entry._tag === "Entrypoint" ? `"${entry.entrypoint}" is not node-runnable` : entry.reason;
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot resolve this fabrika's own entrypoint (${why}) — which invocation the shell would run is UNKNOWN.`,
			);
		}

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
			const child = yield* childGround(epic, epicRead.url, state, issue, notes);
			if (child._tag === "Refused") return child.outcome;
			const ground = child.ground;
			notes.push(...child.notes);
			const brief: LaneBrief = {
				lane: options.lane,
				root,
				fabrika,
				task,
				state,
				shell,
				issue: read.url,
				ground,
			};
			return answer(emitBrief(brief), [
				...notes,
				`${VERB}: task "${task}" is "${state}" on epic #${epic}'s lane — brief the ${shell}; a child state has no PR.`,
			]);
		}

		const nominated = yield* nominateOpenPulls(repo.value, issue);
		if (nominated._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read ${nominated.what}: ${nominated.reason} — UNKNOWN.`,
				notes,
			);
		}
		const traced = tracePulls(issue, nominated.pulls);
		if (traced._tag === "Many") {
			return refuse(
				PR_AMBIGUOUS,
				`${VERB}: ${traced.prs.length} open PRs link #${issue} — exactly one is the lane's, and which is not this verb's to guess.`,
				[...notes, `${VERB}: candidates: ${traced.prs.map((pr) => `#${pr}`).join(", ")}.`],
			);
		}
		if (traced._tag === "None" && !isBuildState(state)) {
			return refuse(
				PR_AMBIGUOUS,
				`${VERB}: ${traced.why} across ${nominationScope(issue)}, and a "${state}" shell has nothing to read without one.`,
				notes,
			);
		}
		const only =
			traced._tag === "One"
				? (nominated.pulls.find((pull) => pull.number === traced.pr) ?? null)
				: null;
		const prUrl = only === null ? null : artifactUrl(only.htmlUrl);
		if (only !== null && prUrl === null) {
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
			epic !== null && prUrl !== null && !isBuildState(state)
				? {_tag: "Tail", pr: prUrl, epic: read.url}
				: {_tag: "Pull", pr: prUrl};
		const brief: LaneBrief = {
			lane: options.lane,
			root,
			fabrika,
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
