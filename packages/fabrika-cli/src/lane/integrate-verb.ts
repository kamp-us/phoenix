/**
 * `lane integrate` — land one reviewed child on an epic run's assembly branch, and prove the merged
 * tree holds together before the branch keeps it.
 *
 * The order is the whole verb: merge, reconcile the merged tree's dependencies from the lockfile it
 * now carries, then run the repo's code validators. Reversing the middle two steps is what #7162 hit
 * — an assembly worktree placed before the child existed still had the pre-merge install, so
 * `pnpm typecheck --force` failed with `TS2688` on a tree whose code was fine, and a valid child
 * spent a lane retry on stale worktree state. Every refusal below the merge resets the branch
 * through `ORIG_HEAD`, so a recorded `FAIL` names a branch that never carried the bad merge.
 *
 * On exit 0 the last stdout line is always `INTEGRATE-VERDICT: MERGED`, the line above it the merged
 * head. Publishing that head is `lane push`'s and recording the `DONE` is the driver's: this verb
 * neither pushes nor writes the lane's log, so its answer is a fact about a tree and nothing else.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {CONFIG_PATH} from "../config/document.ts";
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
	ASSEMBLY_RED,
	ASSEMBLY_UNSEATED,
	LANE_UNREADABLE,
	MERGE_CONFLICT,
	PRIMARY_CHECKOUT,
	PROOF_ABSENT,
	RECONCILE_REFUSED,
} from "./codes.ts";
import {loadRefusal} from "./refusals.ts";
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

/**
 * Put the assembly branch back where the merge found it, and prove it went.
 *
 * `reset --hard ORIG_HEAD` is the move; the re-read of HEAD against the sha captured before the
 * merge is what makes it an answer rather than a claim. A branch that will not go back is UNKNOWN,
 * never a plain `FAIL` — it may still carry the merge no verdict admits.
 */
const restore = (
	path: string,
	head: string,
	outcome: VerbOutcome,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const reset = yield* execCapture("git", ["-C", path, "reset", "--hard", "ORIG_HEAD"]);
		const after = yield* headOf(path);
		if (after._tag === "Unreadable") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: reset ${path} to ORIG_HEAD and cannot re-read its HEAD: ${after.reason} — whether the assembly branch still carries the merge is UNKNOWN.`,
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
		return {
			...outcome,
			stderr: [...outcome.stderr, `${VERB}: reset ${path} back to ${head}; nothing was pushed.`],
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
 * repair (#7188). A repo declaring no reconciler has no install to run and is not refused — see
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
		// `--untracked-files=no`: the claim is about what the install did to the repo's own dependency
		// artifacts, and an untracked file a package manager scratched into the tree is not one.
		const dirty = yield* execCapture("git", [
			"-C",
			path,
			"status",
			"--porcelain",
			"--untracked-files=no",
		]);
		if (!dirty.ok) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					LANE_UNREADABLE,
					`${VERB}: ran ${label} and cannot read whether it changed anything in ${path}: ${dirty.reason} — UNKNOWN, never a pass.`,
				),
			};
		}
		const changed = dirty.stdout.split("\n").filter((line) => line.trim() !== "");
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

		const before = yield* headOf(path);
		if (before._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read the head of ${path}: ${before.reason} — nothing was merged, because there would be nowhere proven to reset back to.`,
			);
		}
		const head = before.sha;

		// `--no-ff` so each landing is one commit a reader can name: a fast-forward would leave two
		// children's ranges indistinguishable in the history the epic reviewer reads.
		const merged = yield* execCapture("git", ["-C", path, "merge", "--no-ff", options.child]);
		if (!merged.ok) {
			const aborted = yield* execCapture("git", ["-C", path, "merge", "--abort"]);
			const after = yield* headOf(path);
			if (after._tag === "Unreadable" || after.sha !== head) {
				return refuse(
					APPEND_UNKNOWN,
					`${VERB}: ${options.child} conflicts with ${branch} and the abort did not restore ${path}${aborted.ok ? "" : `: ${aborted.reason}`} — the tree's state is UNKNOWN, so nothing may be recorded against it.`,
				);
			}
			return refuse(
				MERGE_CONFLICT,
				`${VERB}: ${options.child} conflicts with ${branch}; the merge was aborted and ${path} is back at ${head}. No install ran and no validator ran, because there is no merged tree to judge.`,
				diagnostics(merged.reason),
			);
		}
		const notes = [`${VERB}: merged ${options.child} into ${branch} at ${path}.`];

		const source = loadConfig(yield* readConfigSource(path));
		const reconciler = resolve(source, dependencyReconcilerKey);
		if (reconciler._tag === "Unknown" || reconciler._tag === "Malformed") {
			return yield* restore(
				path,
				head,
				refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot read \`${DEPENDENCY_RECONCILER}\` from ${CONFIG_PATH} (${reconciler.reason}) — how the merged tree's dependencies are reconciled is UNKNOWN, so no validator ran.`,
					notes,
				),
			);
		}
		const reconciled = yield* reconcile(path, reconciler.value);
		if (reconciled._tag === "Refused") {
			return yield* restore(path, head, {
				...reconciled.outcome,
				stderr: [...notes, ...reconciled.outcome.stderr],
			});
		}
		notes.push(reconciled.note);

		const declared = resolve(source, codeValidatorsKey);
		if (declared._tag === "Unknown" || declared._tag === "Malformed") {
			return yield* restore(
				path,
				head,
				refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot read \`${CODE_VALIDATORS}\` from ${CONFIG_PATH} (${declared.reason}) — which commands judge the merged tree is UNKNOWN, never green.`,
					notes,
				),
			);
		}
		if (declared.value.length === 0) {
			return yield* restore(
				path,
				head,
				refuse(
					LANE_UNREADABLE,
					`${VERB}: ${CONFIG_PATH} declares no \`${CODE_VALIDATORS}\` — the merged tree was never judged, so the integration is UNKNOWN, never green and never red.`,
					notes,
				),
			);
		}
		const red = yield* validate(path, declared.value);
		if (red !== null) {
			return yield* restore(path, head, {...red, stderr: [...notes, ...red.stderr]});
		}

		const landed = yield* headOf(path);
		if (landed._tag === "Unreadable") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: the merge and its checks passed and ${path}'s head cannot be read back: ${landed.reason} — what the assembly branch now carries is UNKNOWN.`,
				notes,
			);
		}
		return answer(`${landed.sha}\nINTEGRATE-VERDICT: MERGED\n`, [
			...notes,
			`${VERB}: ${declared.value.length} code validator(s) passed over the merged tree.`,
		]);
	});
