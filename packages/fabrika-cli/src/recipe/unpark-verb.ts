/**
 * `recipe unpark` — clear one parked lane when the park's cause is a known recipe, and refuse
 * without touching anything when it is not.
 *
 * The order is the contract, and every step is somebody else's answer relayed (ADR 0228):
 *
 *   1. `lane status` folds the ledger — this verb never re-folds a log.
 *   2. {@link classifyPark} seats the leaf, and the cause the parking event named, against the
 *      recipe table — a `blocked` carrying no cause keys on nothing (#6480). **Novel refuses here**, before
 *      any read that could write and long before the append, which is what makes the novel exit a
 *      proven no-op rather than a claim about one.
 *   3. The recipe's clearance is read from the verb that owns it — `ship cp-approval`'s ADR 0175
 *      discharge table, never a second reading of §CP in this file.
 *   4. `lane transition … UNBLOCKED` records the clear.
 *   5. `lane status` is folded **again**, and the answer is emitted only once that re-fold shows the
 *      task out of the park (epic #5840's no-go: no recipe reports a mutation it did not read back).
 *
 * Respawning whatever the lane parked out of is the operator's, not this verb's.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {worktreeCheckouts} from "../build/git.ts";
import {childLaneBranches} from "../build/lane.ts";
import {localBranches} from "../io/git.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {openPullsClosing} from "../io/pulls.ts";
import {runStatus} from "../lane/status-verb.ts";
import {runTransition} from "../lane/transition-verb.ts";
import {runCpApproval} from "../ship/cp-approval-verb.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	NOT_PARKED,
	PARK_HOLDS,
	PARK_NOVEL,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	TARGET_ABSENT,
	TASK_UNRESOLVED,
} from "./codes.ts";
import {classifyPark, type ParkRecipe} from "./parks.ts";
import {laneExit, relayRefusal} from "./relay.ts";
import {clearProof, issueOf, leafOf} from "./status-read.ts";
import {openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "fabrika recipe unpark";

export interface UnparkOptions {
	/** The lanes root — `.fabrika/lanes` unless a caller relocates it. */
	readonly root: string;
	/** The lane id under the root — by convention the issue number the lane drives. */
	readonly lane: string;
	/** The task the park sits on; `null` resolves only on a single-task active phase. */
	readonly task: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

type Clearance =
	| {readonly _tag: "Cleared"; readonly mechanism: string}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

type Deps = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

export const runUnpark = (options: UnparkOptions): Effect.Effect<VerbOutcome, never, Deps> =>
	Effect.gen(function* () {
		const ref = {root: options.root, lane: options.lane};

		const before = yield* runStatus(ref);
		if (before.code !== 0) {
			return relayRefusal(VERB, "fabrika lane status", before, laneExit(before.code));
		}
		const read = leafOf(before.stdout, options.task);
		if (read._tag === "Finished") {
			return refuse(
				NOT_PARKED,
				`${VERB}: lane ${options.lane} is "${read.terminal}" — a finished workflow holds no park to clear.`,
			);
		}
		if (read._tag === "Unreadable") {
			return refuse(TASK_UNRESOLVED, `${VERB}: ${read.reason}.`);
		}
		const {task, leaf} = read;

		const parked = classifyPark(leaf, read.cause);
		if (parked._tag === "NotParked") {
			return refuse(
				NOT_PARKED,
				`${VERB}: task "${task}" is "${leaf}", which is not a park — there is nothing to clear.`,
			);
		}
		if (parked._tag === "Novel") {
			return refuse(
				PARK_NOVEL,
				`${VERB}: task "${task}" is parked at "${leaf}" and ${parked.reason} — refusing with the ledger untouched; route this to a human.`,
			);
		}

		const clearance = yield* clear(options, task, parked.recipe);
		if (clearance._tag === "Refused") return clearance.outcome;

		const recorded = yield* runTransition({...ref, event: "UNBLOCKED", task, cause: null});
		if (recorded.code !== 0) {
			return relayRefusal(VERB, "fabrika lane transition", recorded, laneExit(recorded.code));
		}

		const after = yield* runStatus(ref);
		const proof = clearProof(after.code, after.stdout, task);
		if (proof._tag === "Unproven") {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: UNBLOCKED was appended and ${proof.reason} — the clear is NOT proven, and the lane needs a human.`,
				[...after.stderr],
			);
		}

		return answer(
			JSON.stringify({
				lane: options.lane,
				task,
				park: leaf,
				clearance: parked.recipe.clearance,
				mechanism: clearance.mechanism,
				current: proof.leaf,
			}),
			[
				`${VERB}: park "${leaf}" matched a known recipe; cleared via ${clearance.mechanism}.`,
				`${VERB}: re-fold reads "${proof.leaf}" — the clear is proven.`,
			],
		);
	});

/**
 * Read whether the recipe's clearing condition holds — one arm per {@link ParkRecipe.clearance}
 * constructor, so a row added to the table without a read to prove it gone will not compile.
 */
const clear = (
	options: UnparkOptions,
	task: string,
	recipe: ParkRecipe,
): Effect.Effect<Clearance, never, ChildProcessSpawner.ChildProcessSpawner> => {
	switch (recipe.clearance) {
		case "cp-approval":
			return clearCpApproval(options, task, recipe);
		case "branch-free":
			return clearBranchFree(options, task, recipe);
	}
};

/**
 * Read whether the §CP park's clearing condition holds, relaying the verb that owns the question.
 *
 * The answer is `ship cp-approval`'s, at the PR's live head, and its three outcomes route
 * differently on purpose: `discharge` clears, `stop` is the park still holding, and `n/a` means the
 * lane parked at `human:cp-approval` over something that is not a §CP block at all — the mislabeled
 * park `operate` §4 names — which no fixed fix covers and so is novel.
 */
const clearCpApproval = (
	options: UnparkOptions,
	task: string,
	recipe: ParkRecipe,
): Effect.Effect<Clearance, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const no = (outcome: VerbOutcome): Clearance => ({_tag: "Refused", outcome});

		const issue = issueOf(options.lane, task);
		if (issue === null) {
			return no(
				refuse(
					TASK_UNRESOLVED,
					`${VERB}: neither task "${task}" nor lane "${options.lane}" names an issue number, so the park's PR cannot be resolved.`,
				),
			);
		}
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return no(resolved.outcome);
		const repo = resolved.repo;

		const pulls = yield* openPullsClosing(repo, issue);
		if (pulls._tag === "Failure") {
			return no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the open PRs declaring they close #${issue}: ${pulls.reason} — the park's cause is UNKNOWN, never cleared.`,
				),
			);
		}
		const [only, ...rest] = pulls.value;
		if (only === undefined) {
			return no(
				refuse(
					TARGET_ABSENT,
					`${VERB}: no open PR declares it closes #${issue}, and "${recipe.park}" waits on ${recipe.waitingOn} — there is no subject to read.`,
				),
			);
		}
		if (rest.length > 0) {
			return no(
				refuse(
					PARK_NOVEL,
					`${VERB}: ${pulls.value.length} open PRs declare they close #${issue} (${pulls.value
						.map((p) => `#${p.number}`)
						.join(
							", ",
						)}) — which one the park hangs on is not this verb's to guess; route this to a human.`,
				),
			);
		}

		const target = yield* openPull(
			VERB,
			repo,
			only.number,
			(reason) =>
				`${VERB}: cannot read PR #${only.number}: ${reason} — the park's cause is UNKNOWN, never cleared.`,
		);
		if (target._tag === "Refused") return no(target.outcome);
		const head = target.pull.headSha;

		const discharge = yield* runCpApproval({
			pr: only.number,
			sha: head,
			repo,
			json: true,
			env: options.env,
		});
		if (discharge.code !== 0) {
			return no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: fabrika ship cp-approval refused at exit ${discharge.code} — the park's cause is UNKNOWN, never cleared.`,
					[...discharge.stderr],
				),
			);
		}
		const answered = parseJson(discharge.stdout);
		if (!isRecord(answered) || typeof answered.outcome !== "string") {
			return no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: fabrika ship cp-approval exited 0 and named no outcome — the park's cause is UNKNOWN, never cleared.`,
				),
			);
		}
		const scope = scannedLine(VERB, 1, "pull request", `#${only.number} at ${head}`);
		switch (answered.outcome) {
			case "discharge":
				return {
					_tag: "Cleared",
					mechanism: `cp-approval:${String(answered.mechanism ?? "discharge")}`,
				};
			case "stop":
				return no(
					refuse(
						PARK_HOLDS,
						`${VERB}: "${recipe.park}" still waits on ${recipe.waitingOn} — PR #${only.number} is not discharged at ${head}; nothing was written.`,
						[scope],
					),
				);
			default:
				return no(
					refuse(
						PARK_NOVEL,
						`${VERB}: PR #${only.number} is not control-plane, so "${recipe.park}" is parked over something this recipe does not cover — refusing with the ledger untouched; route this to a human.`,
						[scope],
					),
				);
		}
	});

/**
 * Read whether the #6395 park's cause is gone: no working tree of this clone holds the lane branch
 * the build must stand on.
 *
 * The read is `build branch --resume-lane`'s own, in both halves — {@link childLaneBranches} for
 * which branches were cut for the issue, {@link worktreeCheckouts} for which trees hold one — so the
 * clearance is the exact inverse of the refusal it clears rather than a second opinion about it
 * (ADR 0228). Every listed tree counts as a hold, a prunable record included: a checkout is blocked
 * on a stale registration too, so reading one as free would clear a park still standing.
 *
 * A clone carrying no branch for the issue clears nothing. A child's branch is never pushed
 * (ADR 0285), so it lives only in the clone that built it, and "no branch here" is far likelier to
 * mean this is the wrong clone than to mean the tree let go — a target this verb cannot read, never
 * a park it may clear.
 */
const clearBranchFree = (
	options: UnparkOptions,
	task: string,
	recipe: ParkRecipe,
): Effect.Effect<Clearance, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const no = (outcome: VerbOutcome): Clearance => ({_tag: "Refused", outcome});

		const issue = issueOf(options.lane, task);
		if (issue === null) {
			return no(
				refuse(
					TASK_UNRESOLVED,
					`${VERB}: neither task "${task}" nor lane "${options.lane}" names an issue number, so the park's branch cannot be resolved.`,
				),
			);
		}

		const branches = yield* localBranches;
		if (branches._tag === "Failure") {
			return no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read this clone's local branches: ${branches.reason} — whether a working tree still holds #${issue}'s lane branch is UNKNOWN, never cleared.`,
				),
			);
		}
		const candidates = childLaneBranches(issue, branches.value);
		if (candidates.length === 0) {
			return no(
				refuse(
					TARGET_ABSENT,
					`${VERB}: no branch in this clone was cut for #${issue}, and "${recipe.park}" waits on ${recipe.waitingOn} — there is no branch to prove free. A child's branch is never pushed, so run this in the clone that built it.`,
				),
			);
		}

		const checkouts = yield* worktreeCheckouts;
		if (checkouts._tag === "Failure") {
			return no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read which working tree holds ${candidates.join(", ")}: ${checkouts.reason} — the park's cause is UNKNOWN, never cleared.`,
				),
			);
		}
		const held = checkouts.value.filter((checkout) => candidates.includes(checkout.branch));
		const scope = scannedLine(VERB, checkouts.value.length, "working tree", candidates.join(", "));
		if (held.length > 0) {
			return no(
				refuse(
					PARK_HOLDS,
					`${VERB}: "${recipe.park}" still waits on ${recipe.waitingOn} — ${held
						.map((checkout) => `${checkout.branch} is checked out in ${checkout.path}`)
						.join("; ")}; nothing was written.`,
					[scope],
				),
			);
		}

		return {_tag: "Cleared", mechanism: `branch-free:${candidates.join(",")}`};
	});
