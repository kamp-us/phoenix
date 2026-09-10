/**
 * `recipe unpark` — clear one parked lane when the park's cause is a known recipe, and refuse
 * without touching anything when it is not.
 *
 * The order is the contract, and every step is somebody else's answer relayed:
 *
 *   1. `lane status` folds the ledger — this verb never re-folds a log.
 *   2. {@link classifyPark} seats the leaf, and the cause the parking event named, against the
 *      recipe table — a `blocked` carrying no cause keys on nothing. **A founder-routed novel park
 *      refuses here**, before any read that could write and long before the append, which is what
 *      makes the novel exit a proven no-op rather than a claim about one.
 *   3. The recipe's clearance is read from the verb that owns it — `ship cp-approval`'s own
 *      discharge table, never a second reading of §CP in this file. A driver-routed park with no
 *      recipe has no such read, and clears on the driver's rationale instead.
 *   4. `lane transition … UNBLOCKED` records the clear, carrying that rationale where there is one.
 *   5. `lane status` is folded **again**, and the answer is emitted only once that re-fold shows the
 *      task out of the park: no recipe reports a mutation it did not read back.
 *
 * **Whose park it is comes off the cause, never off a judgment made here.** Every park cause carries
 * a route (`lane/report.ts`), and `driver` means the park is machinery a driver session may work
 * itself. Under `.fabrika.jsonc`'s `parkCause.driverRouted: "clear"` that is what happens, and the
 * price is a `--rationale` on the recorded line — a clearance nothing records is one nobody can
 * review, so the verb refuses rather than take it silently. A `founder` route reaches none of this:
 * it behaves exactly as it did before the flag existed.
 *
 * Respawning whatever the lane parked out of is the operator's, not this verb's.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {WORKTREE_HELD} from "../build/codes.ts";
import {reclaimDeadClaim} from "../build/dead-claim.ts";
import {worktreeCheckouts} from "../build/git.ts";
import {childLaneBranches} from "../build/lane.ts";
import {runRetire} from "../build/retire-verb.ts";
import {placedRows, selects} from "../campaign/table.ts";
import {CONFIG_PATH} from "../config/document.ts";
import {PARK_CAUSE, type ParkCauseSurface} from "../config/keys/park-cause.ts";
import {readRoadmapFile} from "../config/paths.ts";
import type {Read} from "../config/read-key.ts";
import {fetchAndResolve, localBranches, readFileAt} from "../io/git.ts";
import {getIssue} from "../io/issues.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {nominatePulls, nominationScope} from "../lane/nominate.ts";
import {tracePulls} from "../lane/prove.ts";
import {routeForCause} from "../lane/report.ts";
import {BUILD_CLAIM_BUDGET_MINUTES} from "../lane/shell-budget.ts";
import {runStatus} from "../lane/status-verb.ts";
import {runTransition} from "../lane/transition-verb.ts";
import {BASE_REF} from "../ledger/ground.ts";
import {runCpApproval} from "../ship/cp-approval-verb.ts";
import {runReconcile} from "../ship/reconcile-verb.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	NOT_PARKED,
	PARK_HOLDS,
	PARK_NOVEL,
	PRECONDITION_UNKNOWN,
	RATIONALE_ABSENT,
	READBACK_MISMATCH,
	TARGET_ABSENT,
	TASK_UNRESOLVED,
} from "./codes.ts";
import {classifyPark, type ParkClass, type ParkRecipe, QUEUE_MOVED_GRANT} from "./parks.ts";
import {buildExit, laneExit, relayRefusal} from "./relay.ts";
import {clearProof, issueOf, leafOf} from "./status-read.ts";
import {openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "fabrika recipe unpark";

export interface UnparkOptions {
	/** The lanes root, already resolved by the adapter — the caller's `--root`, else the derived one. */
	readonly root: string;
	/** The lane id under the root — by convention the issue number the lane drives. */
	readonly lane: string;
	/** The task the park sits on; `null` resolves only on a single-task active phase. */
	readonly task: string | null;
	readonly repo: string | null;
	/** The checkout whose `.fabrika.jsonc` declares where the campaigns table lives. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The instant a stranded claim's age is measured against, ISO — the adapter's clock. */
	readonly now: string;
	/**
	 * The repo's declared `parkCause`, read off `.fabrika.jsonc` by the adapter.
	 *
	 * Its `driverRouted` half is this verb's own axis, and its `uncaused` half rides along to the
	 * `lane transition` below — which never reaches that rule, since the event it records is always
	 * `UNBLOCKED`. Passing the whole surface rather than the one sub-key keeps the config a repo
	 * declares and the config this verb acts on the same object.
	 */
	readonly parkCause: Read<ParkCauseSurface>;
	/**
	 * The driver's own recommendation for clearing a driver-routed park; `null` names none.
	 *
	 * Required exactly where the clear is the driver's to take, and recorded on the `UNBLOCKED` that
	 * takes it. It reaches no other path: a founder-routed park is refused or cleared by its recipe's
	 * proving read, and neither is a judgment this flag would be recording.
	 */
	readonly rationale: string | null;
}

type Clearance =
	| {
			readonly _tag: "Cleared";
			readonly mechanism: string;
			/**
			 * Waits the clear grants on the very `UNBLOCKED` that records it, or `null`.
			 *
			 * Only the queue-stall row grants: its park IS a spent wait budget, so a clear that restored
			 * the state alone would hand the lane one conclusive read and re-park it. Every other
			 * row parks for a reason that is not a budget, and granting there would inflate a budget
			 * nobody spent.
			 */
			readonly waitGrant: number | null;
	  }
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
		if (options.parkCause._tag === "Refused") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read \`${PARK_CAUSE}\` from ${CONFIG_PATH} (${options.parkCause.reason}) — whether this repo lets a driver clear its own parks is UNKNOWN, and nothing was written.`,
			);
		}
		// Normalised once, here, so the line that lands and the answer that reports it carry the same
		// bytes — and so a rationale that is only whitespace refuses as the absent one it is rather
		// than travelling to `lane transition`'s own refusal a step later.
		const rationale = options.rationale?.trim() === "" ? null : (options.rationale?.trim() ?? null);
		const routed = routeOfPark(parked, options.parkCause.value.driverRouted === "clear");
		if (routed._tag === "Human") {
			return refuse(
				PARK_NOVEL,
				`${VERB}: task "${task}" is parked at "${leaf}" and ${routed.reason} — refusing with the ledger untouched; route this to a human.`,
			);
		}
		if (routed._tag === "Driver" && rationale === null) {
			return refuse(
				RATIONALE_ABSENT,
				`${VERB}: task "${task}" is parked at "${leaf}" and "${routed.cause}" routes to the driver, so this clear is the driver's to take and no recipe proves it — pass --rationale saying what you are taking it on. Nothing was written.`,
			);
		}

		const clearance: Clearance =
			routed._tag === "Recipe"
				? yield* clear(options, task, routed.recipe)
				: {
						_tag: "Cleared",
						mechanism: `driver-rationale:${routed.cause}`,
						waitGrant: null,
					};
		if (clearance._tag === "Refused") return clearance.outcome;

		const recorded = yield* runTransition({
			...ref,
			event: "UNBLOCKED",
			task,
			cause: null,
			parkCause: options.parkCause,
			classes: [],
			waitGrant: clearance.waitGrant,
			rationale,
		});
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
				clearance: routed._tag === "Recipe" ? routed.recipe.clearance : "driver-rationale",
				mechanism: clearance.mechanism,
				current: proof.leaf,
				...(clearance.waitGrant === null ? {} : {waitGrant: clearance.waitGrant}),
				...(rationale === null ? {} : {rationale}),
			}),
			[
				routed._tag === "Recipe"
					? `${VERB}: park "${leaf}" matched a known recipe; cleared via ${clearance.mechanism}.`
					: `${VERB}: park "${leaf}" routes to the driver; cleared on the driver's own rationale.`,
				`${VERB}: re-fold reads "${proof.leaf}" — the clear is proven.`,
			],
		);
	});

/**
 * Who clears this park, and how — the one place the recipe table and the cause's route are read
 * together.
 *
 * Three arms and no fourth. `Recipe` is a park with a fixed fix: its clearing condition is read back
 * whatever the cause routes to, because a proving read is a better answer than anybody's judgment.
 * `Driver` is a park with no fixed fix whose cause is machinery the driver session owns, in a repo
 * that declared drivers may take them — there is no read to relay, so the rationale is what stands
 * in its place. `Human` is everything else, and is the refusal this verb always had.
 *
 * A `Driver` arm always names its cause, and that is the route table's own rule rather than a
 * coincidence of the rows: {@link routeForCause} answers `founder` for a park that named none, so a
 * cause-less park never reaches this arm.
 */
type Routing =
	| {readonly _tag: "Recipe"; readonly recipe: ParkRecipe}
	| {readonly _tag: "Driver"; readonly cause: string}
	| {readonly _tag: "Human"; readonly reason: string};

const routeOfPark = (
	parked: Extract<ParkClass, {readonly _tag: "Known" | "Novel"}>,
	driverClears: boolean,
): Routing => {
	if (parked._tag === "Known") return {_tag: "Recipe", recipe: parked.recipe};
	const cause = parked.cause;
	return driverClears && cause !== null && routeForCause(cause) === "driver"
		? {_tag: "Driver", cause}
		: {_tag: "Human", reason: parked.reason};
};

/**
 * Read whether the recipe's clearing condition holds — one arm per {@link ParkRecipe.clearance}
 * constructor, so a row added to the table without a read to prove it gone will not compile.
 */
const clear = (
	options: UnparkOptions,
	task: string,
	recipe: ParkRecipe,
): Effect.Effect<Clearance, never, Deps> => {
	switch (recipe.clearance) {
		case "cp-approval":
			return clearCpApproval(options, task, recipe);
		case "branch-free":
			return clearBranchFree(options, task, recipe);
		case "campaign-active":
			return clearCampaignActive(options, task, recipe);
		case "spawn-clear":
			return clearSpawnClear(options, task, recipe);
		case "queue-moved":
			return clearQueueMoved(options, task, recipe);
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

		// The lane's PR through the shared nominator (`../lane/nominate.ts`): a §CP park sits on the same
		// PR `lane brief` dispatched a shipper against, and a `Part of #N` PR that this verb could not
		// see is a park no recipe could ever clear.
		const nominated = yield* nominatePulls(repo, issue);
		if (nominated._tag === "Unreadable") {
			return no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${nominated.what}: ${nominated.reason} — the park's cause is UNKNOWN, never cleared.`,
				),
			);
		}
		const traced = tracePulls(issue, nominated.pulls);
		if (traced._tag === "None") {
			return no(
				refuse(
					TARGET_ABSENT,
					`${VERB}: ${traced.why} across ${nominationScope(issue)}, and "${recipe.park}" waits on ${recipe.waitingOn} — there is no subject to read.`,
				),
			);
		}
		if (traced._tag === "Many") {
			return no(
				refuse(
					PARK_NOVEL,
					`${VERB}: ${traced.prs.length} open PRs link #${issue} (${traced.prs
						.map((candidate) => `#${candidate}`)
						.join(
							", ",
						)}) — which one the park hangs on is not this verb's to guess; route this to a human.`,
				),
			);
		}
		const pr = traced.pr;

		const target = yield* openPull(
			VERB,
			repo,
			pr,
			(reason) =>
				`${VERB}: cannot read PR #${pr}: ${reason} — the park's cause is UNKNOWN, never cleared.`,
		);
		if (target._tag === "Refused") return no(target.outcome);
		const head = target.pull.headSha;

		const discharge = yield* runCpApproval({
			pr,
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
		const scope = scannedLine(VERB, 1, "pull request", `#${pr} at ${head}`);
		switch (answered.outcome) {
			case "discharge":
				return {
					_tag: "Cleared",
					mechanism: `cp-approval:${String(answered.mechanism ?? "discharge")}`,
					waitGrant: null,
				};
			case "stop":
				return no(
					refuse(
						PARK_HOLDS,
						`${VERB}: "${recipe.park}" still waits on ${recipe.waitingOn} — PR #${pr} is not discharged at ${head}; nothing was written.`,
						[scope],
					),
				);
			default:
				return no(
					refuse(
						PARK_NOVEL,
						`${VERB}: PR #${pr} is not control-plane, so "${recipe.park}" is parked over something this recipe does not cover — refusing with the ledger untouched; route this to a human.`,
						[scope],
					),
				);
		}
	});

/**
 * Read whether the worktree park's cause is gone: no working tree of this clone holds the lane
 * branch the build must stand on.
 *
 * The read is `build branch --resume-lane`'s own, in both halves — {@link childLaneBranches} for
 * which branches were cut for the issue, {@link worktreeCheckouts} for which trees hold one — so the
 * clearance is the exact inverse of the refusal it clears rather than a second opinion about it.
 * Every listed tree counts as a hold, a prunable record included: a checkout is blocked on a stale
 * registration too, so reading one as free would clear a park still standing.
 *
 * A clone carrying no branch for the issue clears nothing. A child's branch is never pushed, so it
 * lives only in the clone that built it, and "no branch here" is far likelier to mean this is the
 * wrong clone than to mean the tree let go — a target this verb cannot read, never a park it may
 * clear.
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

		const freed = yield* treesFreedOf(options, issue, recipe, candidates, []);
		if (freed._tag === "Refused") return no(freed.outcome);

		return {
			_tag: "Cleared",
			mechanism:
				freed.retired === 0
					? `branch-free:${candidates.join(",")}`
					: `branch-free:${candidates.join(",")} (retired ${freed.retired} working tree(s))`,
			waitGrant: null,
		};
	});

type TreeRead =
	| {readonly _tag: "Freed"; readonly retired: number}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * Whether any working tree of this clone still holds one of `candidates`, after the recipe's own
 * remedy verb has had its turn at them.
 *
 * Shared by the two rows that turn on the read — `branch-free`, whose whole cause it is, and
 * `spawn-clear`, for which it is the second half. Every listed tree counts as a hold, a prunable
 * record included: a checkout is blocked on a stale registration too, so reading one as free would
 * clear a park still standing.
 *
 * `scanned` carries the reads the caller already performed, so a refusal from here reports the whole
 * scope the caller covered rather than the tree half alone.
 */
const treesFreedOf = (
	options: UnparkOptions,
	issue: number,
	recipe: ParkRecipe,
	candidates: ReadonlyArray<string>,
	scanned: ReadonlyArray<string>,
): Effect.Effect<TreeRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const no = (outcome: VerbOutcome): TreeRead => ({_tag: "Refused", outcome});

		const checkouts = yield* worktreeCheckouts;
		if (checkouts._tag === "Failure") {
			return no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read which working tree holds ${candidates.join(", ")}: ${checkouts.reason} — the park's cause is UNKNOWN, never cleared.`,
					scanned,
				),
			);
		}
		let held = checkouts.value.filter((checkout) => candidates.includes(checkout.branch));
		const scope = scannedLine(VERB, checkouts.value.length, "working tree", candidates.join(", "));
		let retired = 0;
		if (held.length > 0 && recipe.remedy !== null) {
			const retire = yield* runRetire({number: issue, repo: options.repo, env: options.env});
			// `33` is the retirement proving the board licenses none, which is this recipe's own hold
			// rather than a fault — the re-read below reports it in the recipe's words.
			if (retire.code !== 0 && retire.code !== WORKTREE_HELD) {
				return no(relayRefusal(VERB, `${recipe.remedy} ${issue}`, retire, buildExit(retire.code)));
			}
			const after = yield* worktreeCheckouts;
			if (after._tag === "Failure") {
				return no(
					refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot re-read which working tree holds ${candidates.join(", ")} after the retirement: ${after.reason} — the park's cause is UNKNOWN, never cleared.`,
						[...scanned, scope],
					),
				);
			}
			retired = held.length;
			held = after.value.filter((checkout) => candidates.includes(checkout.branch));
			retired -= held.length;
		}
		if (held.length > 0) {
			return no(
				refuse(
					PARK_HOLDS,
					`${VERB}: "${recipe.park}" still waits on ${recipe.waitingOn} — ${held
						.map((checkout) => `${checkout.branch} is checked out in ${checkout.path}`)
						.join("; ")}; nothing was written.`,
					retired === 0
						? [...scanned, scope]
						: [
								...scanned,
								scope,
								`${VERB}: ${retired} working tree(s) were retired, and these still hold.`,
							],
				),
			);
		}

		return {_tag: "Freed", retired};
	});

/**
 * Read whether the spawn-dead park's cause is gone: the shell the provider killed left nothing
 * behind that would refuse the same brief being dispatched again.
 *
 * It proves a dispatch is possible, never that the provider is back — no verb can spawn an agent, so
 * the operator's next dispatch is that test and a still-down provider re-parks the lane. The two
 * halves are residue the driver session owns: a build claim the dead shell stranded, and a working
 * tree still holding its lane branch, which the row's `build retire` remedy takes back where a
 * license reaches it.
 *
 * **The stranded claim is retracted here, on proof rather than on absence.** There is no heartbeat,
 * so what proves the shell dead is its claim outliving the budget for the kind of work it took
 * (`../lane/shell-budget.ts`), and {@link reclaimDeadClaim} retracts it and re-reads the board to
 * prove it gone. A claim still inside its budget is a shell that may be working, so the park holds;
 * a retraction the re-read does not confirm is a read-back mismatch, never a clear. That is what
 * ends the hand `build adopt` + `build release` this row used to require of a person for a failure
 * nobody chose.
 *
 * A lane carrying no branch for the issue clears on the claim read alone, and that holds for all
 * three shell roles rather than only the two that cut nothing. A dead reviewer or shipper never cut
 * a branch, so "no branch here" is their ordinary case rather than `branch-free`'s wrong clone. A
 * dead builder did cut one, and never pushed it — but it was cut in a worktree of this clone, whose
 * branch refs live in the shared common git dir, so {@link localBranches} lists it here
 * (`.patterns/worktree-agent-constraints.md`; the same sharing `build branch --resume-lane` reads a
 * missing branch as gone rather than elsewhere on). That containment holds only while the unpark runs
 * in the clone that spawned the shell — which is the clone the lane ledger lives in, and nothing
 * enforces it: run this from another clone and a dead builder's zero reads as free, where
 * `branch-free`'s same zero refuses at `TARGET_ABSENT`.
 */
const clearSpawnClear = (
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
					`${VERB}: neither task "${task}" nor lane "${options.lane}" names an issue number, so the dead shell's residue cannot be resolved.`,
				),
			);
		}
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return no(resolved.outcome);

		const nowEpochMs = Date.parse(options.now);
		if (Number.isNaN(nowEpochMs)) {
			return no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: "${options.now}" is not an instant to measure a stranded claim's age against — whether the dead shell's claim is past its budget is UNKNOWN, never cleared.`,
				),
			);
		}
		const reclaimed = yield* reclaimDeadClaim(
			resolved.repo,
			issue,
			nowEpochMs,
			BUILD_CLAIM_BUDGET_MINUTES,
		);
		if (reclaimed._tag === "Unknown") {
			return no(
				refuse(PRECONDITION_UNKNOWN, `${VERB}: ${reclaimed.reason} — the park is not cleared.`),
			);
		}
		if (reclaimed._tag === "StillHeld") {
			return no(
				refuse(
					READBACK_MISMATCH,
					`${VERB}: ${reclaimed.reason} — the retraction is not proven, so nothing here says the park is clear.`,
				),
			);
		}
		const claimed = scannedLine(VERB, reclaimed.scanned, "build claim marker", `#${issue}`);
		if (reclaimed._tag === "Alive") {
			return no(
				refuse(
					PARK_HOLDS,
					`${VERB}: "${recipe.park}" still waits on ${recipe.waitingOn} — ${reclaimed.token} has claimed #${issue} for ${reclaimed.ageMinutes} of its ${reclaimed.budgetMinutes} minute(s), so its shell may still be working. Nothing was written.`,
					[claimed],
				),
			);
		}
		const released =
			reclaimed._tag === "Released"
				? [
						`${VERB}: ${reclaimed.token} had claimed #${issue} for ${reclaimed.ageMinutes} minute(s), past the ${reclaimed.budgetMinutes}-minute budget for the work it took — ${reclaimed.retracted} marker(s) retracted, and #${issue} re-reads unclaimed.`,
					]
				: [];
		// The retraction rides the mechanism as well as stderr: the mechanism is what the answer
		// carries, and a clear that silently evicted a claim would leave no trace in the record.
		const retracted =
			reclaimed._tag === "Released"
				? ` (retracted ${reclaimed.token} at ${reclaimed.ageMinutes}m, past the ${reclaimed.budgetMinutes}-minute budget)`
				: "";

		const branches = yield* localBranches;
		if (branches._tag === "Failure") {
			return no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read this clone's local branches: ${branches.reason} — whether a working tree still holds #${issue}'s lane branch is UNKNOWN, never cleared.`,
					[claimed, ...released],
				),
			);
		}
		const candidates = childLaneBranches(issue, branches.value);
		if (candidates.length === 0) {
			return {
				_tag: "Cleared",
				mechanism: `spawn-clear:#${issue} unclaimed${retracted}, no lane branch`,
				waitGrant: null,
			};
		}

		const freed = yield* treesFreedOf(options, issue, recipe, candidates, [claimed, ...released]);
		if (freed._tag === "Refused") return no(freed.outcome);

		return {
			_tag: "Cleared",
			mechanism:
				freed.retired === 0
					? `spawn-clear:#${issue} unclaimed${retracted}, ${candidates.join(",")} free`
					: `spawn-clear:#${issue} unclaimed${retracted}, ${candidates.join(",")} free (retired ${freed.retired} working tree(s))`,
			waitGrant: null,
		};
	});

/**
 * Read whether the campaign-paused park's cause is gone: the campaign homing this lane's milestone
 * reads `active` again.
 *
 * Two reads that both already exist, composed rather than re-derived — the lane issue's `milestone`
 * off `../io/issues.ts`, and the `## Campaigns` row off `../campaign/table.ts`, which is the fence's
 * own parse and so cannot disagree with the permission `build claim` enforces. The row is
 * read at {@link BASE_REF} rather than in the working tree because a resume lands on the trunk and a
 * lane clone can be arbitrarily stale; the fetch is what makes that read current.
 *
 * Every arm below leaves the park standing, and each names which one it hit: a campaign that cannot
 * be read is UNKNOWN, an unhomed lane and an unpinned milestone are targets this verb cannot read,
 * and `paused` or `done` is the park still holding. None of them may resume a campaign — that stays
 * `campaign state`'s, behind a human's citation.
 */
const clearCampaignActive = (
	options: UnparkOptions,
	task: string,
	recipe: ParkRecipe,
): Effect.Effect<Clearance, never, Deps> =>
	Effect.gen(function* () {
		const no = (outcome: VerbOutcome): Clearance => ({_tag: "Refused", outcome});
		const unknown = (what: string, reason: string): Clearance =>
			no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${what}: ${reason} — whether the campaign still reads paused is UNKNOWN, never cleared.`,
				),
			);

		const number = issueOf(options.lane, task);
		if (number === null) {
			return no(
				refuse(
					TASK_UNRESOLVED,
					`${VERB}: neither task "${task}" nor lane "${options.lane}" names an issue number, so the lane's milestone cannot be resolved.`,
				),
			);
		}
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return no(resolved.outcome);

		const found = yield* getIssue(resolved.repo, number);
		if (found._tag === "Unknown") return unknown(`issue #${number}`, found.reason);
		if (found._tag === "Absent") {
			return no(refuse(TARGET_ABSENT, `${VERB}: issue #${number} is proven absent.`));
		}
		const milestone = found.value.milestone;
		if (milestone === null) {
			return no(
				refuse(
					TARGET_ABSENT,
					`${VERB}: issue #${number} is homed on no milestone, and "${recipe.park}" waits on ${recipe.waitingOn} — there is no campaign row to read.`,
				),
			);
		}

		const declared = yield* readRoadmapFile(options.cwd);
		if (declared._tag === "Refused") {
			return unknown(CONFIG_PATH, declared.reason.replace(/\.$/, ""));
		}
		const roadmap = declared.value;

		const trunk = yield* fetchAndResolve(BASE_REF);
		if (trunk._tag === "Failure") return unknown(BASE_REF, trunk.reason);
		const text = yield* readFileAt(trunk.value, roadmap);
		if (text._tag === "Failure") return unknown(`${roadmap} at ${BASE_REF}`, text.reason);

		const placed = placedRows(text.value);
		if (placed._tag === "Malformed") {
			return unknown(`the ## Campaigns table in ${roadmap} at ${BASE_REF}`, placed.reason);
		}
		const scope = scannedLine(
			VERB,
			placed.rows.length,
			"campaign row",
			`${roadmap} at ${BASE_REF}`,
		);
		const row = placed.rows.find((candidate) => selects(candidate, `#${milestone}`))?.row;
		if (row === undefined) {
			return no(
				refuse(
					TARGET_ABSENT,
					`${VERB}: no ## Campaigns row in ${roadmap} pins milestone #${milestone}, which homes #${number}, and "${recipe.park}" waits on ${recipe.waitingOn} — there is no permission cell to read.`,
					[scope],
				),
			);
		}
		if (row.state !== "active") {
			return no(
				refuse(
					PARK_HOLDS,
					`${VERB}: "${recipe.park}" still waits on ${recipe.waitingOn} — "${row.name}" #${milestone} reads ${row.state}; nothing was written.`,
					[scope],
				),
			);
		}

		return {_tag: "Cleared", mechanism: `campaign-active:#${milestone}`, waitGrant: null};
	});

/**
 * Read whether the queue-stall park's cause is gone: the merge queue has actually moved this PR.
 *
 * The read is `ship reconcile`'s answer relayed and never a second reading of the queue here, at one
 * poll because a recipe pass is a snapshot — the dwelling is what the lane already
 * did. Two of its four answers clear, and both are the queue having finished with the PR: `landed`
 * and `ejected`. `unresolved` is the queue still working, which is the park standing correctly, and
 * `parked` says the arm never entered a queue at all — a different fault from a slow queue, whose
 * remedy is `ship disarm --site post-enqueue` and so a human's.
 *
 * It is the one row whose clear also **grants**, and that is the whole shape of the row: the
 * park IS a spent wait budget, so restoring the state alone would buy one conclusive read and
 * re-park the lane. The grant rides the same recorded `UNBLOCKED`, so there is no bare resume for
 * the fold's wait-axis refusal to catch and no second line anybody has to remember to write.
 *
 * The PR is resolved at `open-or-merged` scope, because the clearing case is a merged and therefore
 * closed PR: nominating open PRs alone would refuse at {@link TARGET_ABSENT} on this row's own
 * success case. Several candidates is still not this verb's to pick between.
 */
const clearQueueMoved = (
	options: UnparkOptions,
	task: string,
	recipe: ParkRecipe,
): Effect.Effect<Clearance, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const no = (outcome: VerbOutcome): Clearance => ({_tag: "Refused", outcome});
		const SCOPE = "open-or-merged" as const;

		const issue = issueOf(options.lane, task);
		if (issue === null) {
			return no(
				refuse(
					TASK_UNRESOLVED,
					`${VERB}: neither task "${task}" nor lane "${options.lane}" names an issue number, so the queued PR cannot be resolved.`,
				),
			);
		}
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return no(resolved.outcome);
		const repo = resolved.repo;

		const nominated = yield* nominatePulls(repo, issue, SCOPE);
		if (nominated._tag === "Unreadable") {
			return no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${nominated.what}: ${nominated.reason} — whether the queue moved is UNKNOWN, never cleared.`,
				),
			);
		}
		const traced = tracePulls(issue, nominated.pulls, SCOPE);
		if (traced._tag === "None") {
			return no(
				refuse(
					TARGET_ABSENT,
					`${VERB}: ${traced.why} across ${nominationScope(issue, SCOPE)}, and "${recipe.park}" waits on ${recipe.waitingOn} — there is no subject to read.`,
				),
			);
		}
		if (traced._tag === "Many") {
			return no(
				refuse(
					PARK_NOVEL,
					`${VERB}: ${traced.prs.length} PRs link #${issue} (${traced.prs
						.map((candidate) => `#${candidate}`)
						.join(
							", ",
						)}) — which one the stall hangs on is not this verb's to guess; route this to a human.`,
				),
			);
		}
		const pr = traced.pr;
		const scope = scannedLine(VERB, 1, "pull request", `#${pr}`);

		const watched = yield* runReconcile({
			pr,
			polls: 1,
			cadenceSeconds: 0,
			repo,
			json: true,
			env: options.env,
		});
		if (watched.code !== 0) {
			return no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: fabrika ship reconcile refused at exit ${watched.code} — whether the queue moved is UNKNOWN, never cleared.`,
					[...watched.stderr],
				),
			);
		}
		const answered = parseJson(watched.stdout);
		if (!isRecord(answered) || typeof answered.outcome !== "string") {
			return no(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: fabrika ship reconcile exited 0 and named no outcome — whether the queue moved is UNKNOWN, never cleared.`,
				),
			);
		}
		switch (answered.outcome) {
			case "landed":
			case "ejected":
				return {
					_tag: "Cleared",
					mechanism: `queue-moved:#${pr} ${answered.outcome}`,
					waitGrant: QUEUE_MOVED_GRANT,
				};
			case "unresolved":
				return no(
					refuse(
						PARK_HOLDS,
						`${VERB}: "${recipe.park}" still waits on ${recipe.waitingOn} — PR #${pr} reconciles "unresolved", still queued; nothing was written.`,
						[scope],
					),
				);
			default:
				return no(
					refuse(
						PARK_NOVEL,
						`${VERB}: PR #${pr} reconciles "${answered.outcome}", so "${recipe.park}" is parked over something this recipe does not cover — a merge arm that never entered the queue is \`ship disarm --site post-enqueue\`'s, not a dwell's. Refusing with the ledger untouched; route this to a human.`,
						[scope],
					),
				);
		}
	});
