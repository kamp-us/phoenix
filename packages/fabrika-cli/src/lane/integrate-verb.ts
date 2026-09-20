/**
 * `lane integrate` — land one reviewed child on an epic run's assembly branch, and prove the merged
 * tree holds together before the branch keeps it.
 *
 * The order is the whole verb: merge, reconcile the merged tree's dependencies from the lockfile it
 * now carries, then run the repo's code validators. Reversing the middle two steps is what broke
 * a real run: an assembly worktree placed before the child existed still had the pre-merge install,
 * so the typecheck failed on a tree whose code was fine, and a valid child
 * spent a lane retry on stale worktree state. Every refusal below the merge resets the branch
 * through `ORIG_HEAD`, so a recorded `FAIL` names a branch that never carried the bad merge.
 *
 * Above the merge sits the other half of that guarantee: a seat already holding modified tracked
 * files is refused on exit 45 before anything runs, because dirt the child did not write reads as
 * its conflict or its bad lockfile and spends its retry budget either way.
 *
 * A textual collision is not always the end of the run: under `assemblyReplay.onCollision`, the
 * child's commits are replayed onto the tip and the plain keep-both hunks kept both ways, which is
 * the repair a hand-resolved cross-child collision always was (`replay.ts`). The key ships `off`, so
 * a repo declaring nothing gets the refusal byte for byte. The replay also moves the child's branch
 * onto the range it replayed, and refuses on exit 54 rather than merging when it cannot: the branch
 * is where every later read takes the child's range from, so one left on superseded commits sends
 * the child's next integrate into a collision with this one's own landing. A refusal below the merge
 * puts that branch back too, so a replay this verb did not keep leaves the graded range where its
 * reviewer left it — see {@link restore}.
 *
 * Publishing the merged head is `lane push`'s job; the driver records `DONE`. This verb neither
 * pushes nor writes the lane log. See ./command.ts help for its report format.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {CONFIG_PATH} from "../config/document.ts";
import {ASSEMBLY_REPLAY, assemblyReplayKey} from "../config/keys/assembly-replay.ts";
import {
	CODE_VALIDATORS,
	type CodeValidator,
	codeValidatorsKey,
} from "../config/keys/code-validators.ts";
import {
	DEPENDENCY_RECONCILER,
	type DependencyReconciler,
	dependencyReconcilerKey,
} from "../config/keys/dependency-reconciler.ts";
import {loadConfig, resolve} from "../config/load.ts";
import {readConfigSource} from "../config/source.ts";
import {execCapture, execStatus} from "../io/exec.ts";
import {localBranches} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {epicBranch} from "../wire/lane-brief.ts";
import {assemblySeat, worktrees} from "./assembly.ts";
import {
	APPEND_UNKNOWN,
	ASSEMBLY_DIRTY,
	ASSEMBLY_RED,
	ASSEMBLY_UNSEATED,
	CHILD_UNSEATED,
	LANE_UNREADABLE,
	MERGE_CONFLICT,
	PRIMARY_CHECKOUT,
	PROOF_ABSENT,
	RECONCILE_REFUSED,
} from "./codes.ts";
import {loadRefusal} from "./refusals.ts";
import {type MovedRange, REPLAY_PARK_CAUSE, replayChild} from "./replay.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane integrate";

export interface IntegrateOptions extends LaneRef {
	readonly epic: number;
	/** The child's branch, taken off `lane prove`'s PASS evidence — never a name the caller composed. */
	readonly child: string;
}

/** Diagnostics are the child's own; 40 lines is what a refusal can carry without burying its reason. */
const DIAGNOSTIC_LINES = 40;

const diagnostics = (output: string): ReadonlyArray<string> => {
	const lines = output.split("\n").filter((line) => line.trim() !== "");
	return lines.length <= DIAGNOSTIC_LINES
		? lines
		: [
				...lines.slice(0, DIAGNOSTIC_LINES),
				`… ${lines.length - DIAGNOSTIC_LINES} more line(s); re-run the command itself for the rest.`,
			];
};

const headOf = (path: string) =>
	Effect.map(execCapture("git", ["-C", path, "rev-parse", "HEAD"]), (read) =>
		read.ok
			? ({_tag: "Read", sha: read.stdout.trim()} as const)
			: ({_tag: "Unreadable", reason: read.reason} as const),
	);

/** Where one branch points, read the same way and answered in the same three shapes as {@link headOf}. */
const revisionOf = (path: string, branch: string) =>
	Effect.map(execCapture("git", ["-C", path, "rev-parse", branch]), (read) =>
		read.ok
			? ({_tag: "Read", sha: read.stdout.trim()} as const)
			: ({_tag: "Unreadable", reason: read.reason} as const),
	);

type TrackedChanges =
	| {readonly _tag: "Read"; readonly paths: ReadonlyArray<string>}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * The tracked paths git reports as changed in `path`.
 *
 * `--untracked-files=no` is the whole scope claim: this is the set `git merge` refuses to overwrite
 * and the set an install can repair, and a file no commit tracks is neither. Both readers of this —
 * the pre-merge cleanliness gate and {@link reconcile}'s post-install probe — need the same set, and
 * the second is only a claim about the install because the first proved the baseline empty.
 */
const trackedChanges = (
	path: string,
): Effect.Effect<TrackedChanges, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.map(
		execCapture("git", ["-C", path, "status", "--porcelain", "--untracked-files=no"]),
		(read) =>
			read.ok
				? ({
						_tag: "Read",
						paths: read.stdout.split("\n").filter((line) => line.trim() !== ""),
					} as const)
				: ({_tag: "Unreadable", reason: read.reason} as const),
	);

/**
 * Put the assembly branch back where the merge found it, and prove it went.
 *
 * `reset --hard <to>` is the move; the re-read of HEAD against the sha captured before the merge is
 * what makes it an answer rather than a claim. A branch that will not go back is UNKNOWN, never a
 * plain `FAIL` — it may still carry the merge no verdict admits.
 *
 * The merge and validator paths reset through `ORIG_HEAD`, which the merge itself wrote. The replay
 * path passes the captured sha instead: `git cherry-pick` writes no `ORIG_HEAD`, so on that path the
 * ref names whatever the last thing that did wrote, and resetting to it would be a guess. The proof
 * is the same either way.
 *
 * `reseat` is the replay path's other half, and without it the restore was only half a restore. A
 * replay moves the child's branch onto the replayed range **before** the merge, which is right while
 * the merge stands: the replayed commits are the child's range then, and a branch left on the
 * originals collides with this run's own landing. When a refusal below the merge takes the merge
 * away, that stops being true — the assembly branch goes back and the child would be left naming
 * commits no reviewer graded and nothing carries, with no event to say so, because a refusal writes
 * no stdout. So the branch goes back too, and the graded range never moved at all.
 */
const restore = (
	path: string,
	to: string,
	head: string,
	outcome: VerbOutcome,
	reseat: Reseat = null,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const reset = yield* execCapture("git", ["-C", path, "reset", "--hard", to]);
		const after = yield* headOf(path);
		if (after._tag === "Unreadable") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: reset ${path} to ${to} and cannot re-read its HEAD: ${after.reason} — whether the assembly branch still carries the merge is UNKNOWN.`,
				outcome.stderr,
			);
		}
		if (after.sha !== head) {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: ${path} is at ${after.sha}, not the pre-merge ${head}${reset.ok ? "" : `: ${reset.reason}`} — the assembly branch still carries the merge; it was NOT restored.`,
				outcome.stderr,
			);
		}
		const back = [...outcome.stderr, `${VERB}: reset ${path} back to ${head}; nothing was pushed.`];
		if (reseat === null) return {...outcome, stderr: back};

		const moved = yield* execCapture("git", [
			"-C",
			path,
			"branch",
			"--force",
			reseat.child,
			reseat.to,
		]);
		const seated = yield* revisionOf(path, reseat.child);
		if (seated._tag === "Unreadable" || seated.sha !== reseat.to) {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: ${path} went back to ${head} and ${reseat.child} was NOT put back on ${reseat.to}${moved.ok ? "" : `: ${moved.reason}`} — the child's branch still names the replayed range no reviewer graded, so what its next integrate would merge is UNKNOWN.`,
				back,
			);
		}
		return {
			...outcome,
			stderr: [
				...back,
				`${VERB}: put ${reseat.child} back on ${reseat.to} — the merge is gone, so the graded range never moved and no review round is owed.`,
			],
		};
	});

/** A child branch to put back where the replay found it, or `null` on a path that replayed nothing. */
type Reseat = {readonly child: string; readonly to: string} | null;

/** What the merge itself wrote, and what the merge and validator paths reset back through. */
const ORIG_HEAD = "ORIG_HEAD";

/**
 * The machinery event a replay records, and the whole of what a reader downstream gets from it.
 *
 * `reReview` is the verdict this run owes the child: its commits are on a head no reviewer has seen,
 * so the graded range moved and one round over the new one is what makes the grade true again.
 * `budget` is the classification the retry-budget wiring reads — a replay is machinery working, not
 * the child failing, so it never spends a repair round. Recording it here rather than spending it is
 * deliberate: this verb writes no lane log, so the classification travels as a fact in its answer.
 */
interface ReplayEvent {
	readonly event: "replayed";
	readonly child: string;
	readonly replay: string;
	readonly onto: string;
	readonly range: MovedRange;
	readonly resolved: ReadonlyArray<string>;
	readonly commits: number;
	readonly reReview: "required";
	readonly budget: "unspent";
}

type Landing =
	| {
			readonly _tag: "Landed";
			readonly notes: ReadonlyArray<string>;
			/** What a later refusal resets through — see {@link restore}. */
			readonly resetRef: string;
			readonly replay: ReplayEvent | null;
	  }
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

interface LandOptions {
	readonly path: string;
	readonly branch: string;
	readonly child: string;
	readonly head: string;
}

/**
 * Get the child onto the assembly branch — by merging it, or, on a collision the repo has turned the
 * replay on for, by replaying its commits onto the tip.
 *
 * The collision arm is the whole of what `assemblyReplay.onCollision` gates, and with the key off
 * this is the refusal the verb has always given, down to its diagnostics.
 */
const land = (
	options: LandOptions,
): Effect.Effect<
	Landing,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {path, branch, child, head} = options;

		// `--no-ff` so each landing is one commit a reader can name: a fast-forward would leave two
		// children's ranges indistinguishable in the history the epic reviewer reads.
		const merged = yield* execCapture("git", ["-C", path, "merge", "--no-ff", child]);
		if (merged.ok) {
			return {
				_tag: "Landed" as const,
				notes: [`${VERB}: merged ${child} into ${branch} at ${path}.`],
				resetRef: ORIG_HEAD,
				replay: null,
			};
		}

		const aborted = yield* execCapture("git", ["-C", path, "merge", "--abort"]);
		const after = yield* headOf(path);
		if (after._tag === "Unreadable" || after.sha !== head) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					APPEND_UNKNOWN,
					`${VERB}: ${child} conflicts with ${branch} and the abort did not restore ${path}${aborted.ok ? "" : `: ${aborted.reason}`} — the tree's state is UNKNOWN, so nothing may be recorded against it.`,
				),
			};
		}

		const gate = resolve(loadConfig(yield* readConfigSource(path)), assemblyReplayKey);
		if (gate._tag === "Unknown" || gate._tag === "Malformed") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					LANE_UNREADABLE,
					`${VERB}: ${child} conflicts with ${branch} and \`${ASSEMBLY_REPLAY}\` cannot be read from ${CONFIG_PATH} (${gate.reason}) — whether the collision is replayed is UNKNOWN, so nothing was replayed and ${path} is back at ${head}.`,
				),
			};
		}
		if (gate.value.onCollision === "off") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					MERGE_CONFLICT,
					`${VERB}: ${child} conflicts with ${branch}; the merge was aborted and ${path} is back at ${head}. No install ran and no validator ran, because there is no merged tree to judge.`,
					diagnostics(merged.reason),
				),
			};
		}

		const replayed = yield* replayChild({path, branch, child, tip: head});
		if (replayed._tag === "Unreadable") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					APPEND_UNKNOWN,
					`${VERB}: ${child} was being replayed onto ${head} and ${replayed.reason} — nothing may be recorded against ${path}.`,
				),
			};
		}
		if (replayed._tag === "ChildUnseated") {
			return {
				_tag: "Refused" as const,
				outcome: yield* restore(
					path,
					head,
					head,
					refuse(
						CHILD_UNSEATED,
						`${VERB}: ${child} replayed onto ${head} as ${replayed.replayBranch} and ${replayed.reason} — the replayed range is the child's range now, so nothing was merged and ${path} is back at ${head}. A working tree still standing on ${child} is the usual reason: free it with \`fabrika build retire\` and integrate again, or park the lane on \`--cause worktree-holds-branch\`.`,
					),
				),
			};
		}
		if (replayed._tag === "NotKeepBoth") {
			return {
				_tag: "Refused" as const,
				outcome: yield* restore(
					path,
					head,
					head,
					refuse(
						MERGE_CONFLICT,
						`${VERB}: ${child} replayed onto ${head} and ${replayed.reason} — keeping both sides is the only resolution this verb makes, so the replay was abandoned. Park the lane on \`--cause ${REPLAY_PARK_CAUSE}\`.`,
						replayed.paths,
					),
				),
			};
		}

		return {
			_tag: "Landed" as const,
			notes: [
				`${VERB}: ${child} conflicted with ${branch} and was replayed onto ${head} as ${replayed.replayBranch} — ${replayed.commits} commit(s), ${replayed.resolved.length} path(s) kept both ways — then merged into ${branch} at ${path}.`,
				`${VERB}: ${child} was moved onto the replayed range, so it names the commits ${branch} carries and the child's next integrate is up to date.`,
			],
			// `git cherry-pick` writes no `ORIG_HEAD`, so the replay path resets through the sha this run
			// captured rather than a ref something else last wrote.
			resetRef: head,
			replay: {
				event: "replayed",
				child,
				replay: replayed.replayBranch,
				onto: head,
				range: replayed.range,
				resolved: replayed.resolved,
				commits: replayed.commits,
				reReview: "required",
				budget: "unspent",
			},
		};
	});

type ReconcileOutcome =
	| {readonly _tag: "Reconciled"; readonly note: string}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * Install what the merged lockfile pins, then prove the install changed no tracked file.
 *
 * The second half is the fail-closed half: a reconciliation that rewrites the lockfile has repaired
 * the child's declaration rather than honoured it, and an assembly branch must never carry that
 * repair. A repo declaring no reconciler has no install to run and is not refused — see
 * `config/keys/dependency-reconciler.ts`.
 */
const reconcile = (
	path: string,
	declared: DependencyReconciler,
): Effect.Effect<ReconcileOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (declared === null) {
			return {
				_tag: "Reconciled" as const,
				note: `${VERB}: ${CONFIG_PATH} declares no \`${DEPENDENCY_RECONCILER}\` — no install to run, so the merged tree's dependencies are whatever it already had.`,
			};
		}
		const label = declared.argv.join(" ");
		const [binary, ...args] = declared.argv;
		const ran = yield* execStatus(binary, args, path);
		if (ran._tag === "Unstartable") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					RECONCILE_REFUSED,
					`${VERB}: ${label} could not be executed in ${path}: ${ran.reason} — the merged tree's dependencies are still the pre-merge ones, so nothing it compiles would be about the merge.`,
				),
			};
		}
		if (!ran.ok) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					RECONCILE_REFUSED,
					`${VERB}: ${label} failed in ${path} — the merged lockfile does not install; diagnostics above.`,
					diagnostics(ran.output),
				),
			};
		}
		const dirty = yield* trackedChanges(path);
		if (dirty._tag === "Unreadable") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					LANE_UNREADABLE,
					`${VERB}: ran ${label} and cannot read whether it changed anything in ${path}: ${dirty.reason} — UNKNOWN, never a pass.`,
				),
			};
		}
		const changed = dirty.paths;
		if (changed.length > 0) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					RECONCILE_REFUSED,
					`${VERB}: ${label} changed ${changed.length} tracked path(s) in ${path} — the merged lockfile is not what the manifests pin, and an assembly branch never carries an install's own repair.`,
					changed,
				),
			};
		}
		return {
			_tag: "Reconciled" as const,
			note: `${VERB}: ${label} reconciled ${path} against the merged lockfile, changing nothing tracked.`,
		};
	});

/** Run the repo's declared code validators over the merged tree; the first red is the answer. */
const validate = (
	path: string,
	validators: ReadonlyArray<CodeValidator>,
): Effect.Effect<VerbOutcome | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		for (const {argv} of validators) {
			const label = argv.join(" ");
			const [binary, ...args] = argv;
			const ran = yield* execStatus(binary, args, path);
			if (ran._tag === "Unstartable") {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: ${label} could not be executed in ${path}: ${ran.reason} — whether the merged tree holds together is UNKNOWN, never green.`,
				);
			}
			if (!ran.ok) {
				return refuse(
					ASSEMBLY_RED,
					`${VERB}: red — ${label} failed over the merged tree; diagnostics above.`,
					diagnostics(ran.output),
				);
			}
		}
		return null;
	});

export const runIntegrate = (
	options: IntegrateOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);

		const branch = epicBranch(options.epic);
		const listed = yield* worktrees;
		if (listed._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read this repository's working trees: ${listed.reason} — where ${branch} is checked out is UNKNOWN, so nothing was merged.`,
			);
		}
		const seat = assemblySeat(listed.value, options.epic, branch);
		if (seat._tag === "Conscripted") {
			return refuse(
				PRIMARY_CHECKOUT,
				`${VERB}: ${branch} is checked out in the main working tree (${seat.path}) — an integration never merges into the driver's checkout. Switch that tree off ${branch} and place the run's own with \`fabrika lane assembly ${options.epic}\`.`,
			);
		}
		if (seat._tag !== "Isolated") {
			return refuse(
				ASSEMBLY_UNSEATED,
				`${VERB}: no working tree holds ${branch} — place the run's assembly worktree with \`fabrika lane assembly ${options.epic}\` before integrating a child.`,
			);
		}
		const path = seat.path;

		const branches = yield* localBranches;
		if (branches._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read this repository's branches: ${branches.reason} — whether ${options.child} exists is UNKNOWN, so nothing was merged.`,
			);
		}
		if (!branches.value.includes(options.child)) {
			return refuse(
				PROOF_ABSENT,
				`${VERB}: no branch named ${options.child} in this repository — take the child's branch off \`lane prove\`'s PASS evidence, never a name composed from the number.`,
			);
		}

		// Read before anything moves: on the replay path this is the revision the child's reviewer
		// graded, and it is what {@link restore} puts the branch back on when the merge comes off.
		const graded = yield* revisionOf(path, options.child);
		if (graded._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read where ${options.child} points in ${path}: ${graded.reason} — nothing was merged, because a replay would have nowhere proven to put the branch back.`,
			);
		}

		const before = yield* headOf(path);
		if (before._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read the head of ${path}: ${before.reason} — nothing was merged, because there would be nowhere proven to reset back to.`,
			);
		}
		const head = before.sha;

		const seated = yield* trackedChanges(path);
		if (seated._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read whether ${path} is clean before the merge: ${seated.reason} — whether a later refusal would be ${options.child}'s or this tree's is UNKNOWN, so nothing was merged.`,
			);
		}
		if (seated.paths.length > 0) {
			return refuse(
				ASSEMBLY_DIRTY,
				`${VERB}: ${path} already held ${seated.paths.length} modified tracked path(s) before ${options.child} was merged — that is the driver's tree and not the child's range, so nothing was merged, installed or validated and ${path} is still at ${head}. Clean the seat, then integrate again.`,
				seated.paths,
			);
		}

		const landing = yield* land({path, branch, child: options.child, head});
		if (landing._tag === "Refused") return landing.outcome;
		const {resetRef, replay} = landing;
		const notes = [...landing.notes];
		const reseat: Reseat = replay === null ? null : {child: options.child, to: graded.sha};

		const source = loadConfig(yield* readConfigSource(path));
		const reconciler = resolve(source, dependencyReconcilerKey);
		if (reconciler._tag === "Unknown" || reconciler._tag === "Malformed") {
			return yield* restore(
				path,
				resetRef,
				head,
				refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot read \`${DEPENDENCY_RECONCILER}\` from ${CONFIG_PATH} (${reconciler.reason}) — how the merged tree's dependencies are reconciled is UNKNOWN, so no validator ran.`,
					notes,
				),
				reseat,
			);
		}
		const reconciled = yield* reconcile(path, reconciler.value);
		if (reconciled._tag === "Refused") {
			return yield* restore(
				path,
				resetRef,
				head,
				{...reconciled.outcome, stderr: [...notes, ...reconciled.outcome.stderr]},
				reseat,
			);
		}
		notes.push(reconciled.note);

		const declared = resolve(source, codeValidatorsKey);
		if (declared._tag === "Unknown" || declared._tag === "Malformed") {
			return yield* restore(
				path,
				resetRef,
				head,
				refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot read \`${CODE_VALIDATORS}\` from ${CONFIG_PATH} (${declared.reason}) — which commands judge the merged tree is UNKNOWN, never green.`,
					notes,
				),
				reseat,
			);
		}
		if (declared.value.length === 0) {
			return yield* restore(
				path,
				resetRef,
				head,
				refuse(
					LANE_UNREADABLE,
					`${VERB}: ${CONFIG_PATH} declares no \`${CODE_VALIDATORS}\` — the merged tree was never judged, so the integration is UNKNOWN, never green and never red.`,
					notes,
				),
				reseat,
			);
		}
		const red = yield* validate(path, declared.value);
		if (red !== null) {
			return yield* restore(
				path,
				resetRef,
				head,
				{...red, stderr: [...notes, ...red.stderr]},
				reseat,
			);
		}

		const landed = yield* headOf(path);
		if (landed._tag === "Unreadable") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: the merge and its checks passed and ${path}'s head cannot be read back: ${landed.reason} — what the assembly branch now carries is UNKNOWN.`,
				notes,
			);
		}
		const passed = `${VERB}: ${declared.value.length} code validator(s) passed over the merged tree.`;
		return replay === null
			? answer(`${landed.sha}\nINTEGRATE-VERDICT: MERGED\n`, [...notes, passed])
			: answer(`${JSON.stringify(replay)}\n${landed.sha}\nINTEGRATE-VERDICT: REPLAYED\n`, [
					...notes,
					passed,
					`${VERB}: ${options.child}'s graded range moved to ${replay.range.from}..${replay.range.to} — it owes one review round over the new range, and the replay spends none of its repair budget.`,
				]);
	});
