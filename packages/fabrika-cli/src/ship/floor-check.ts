/**
 * `ship floor --publish-check` — the same floor, seated on a check-run instead of an exit code.
 *
 * A GitHub Actions job's conclusion is success/failure/cancelled/skipped and nothing else, so while
 * the floor was seated on the job's exit code, "no verdict posted at this head yet" — the ordinary
 * mid-lane state every governance-root PR passes through — showed a human the same red as a verdict
 * that is FAIL or bound to another head. Five of six red open PRs were red on exactly that on
 * 2026-08-18, and a red that means "not yet" trains people to stop reading reds (#6161).
 *
 * A check-run has the state a job conclusion does not: it can stay `in_progress`. So the absent
 * verdict leaves the check pending, which reads as "waiting" to a human and still withholds a merge
 * — a pending required check is not a passing one, and `ship checks` rolls it up as `pending` rather
 * than green. The founder ruled the mechanism on
 * [2026-08-20](https://github.com/kamp-us/phoenix/issues/6161#issuecomment-5364681459); ADR 0318
 * carries the why.
 *
 * **The verb writes the check-run; the job only relays what it did** (ADR 0228). Nothing in
 * `governance-floor.yml` decides a conclusion, and nothing here re-derives the floor: the answer is
 * `./floor-verb.ts`'s `resolveFloor`, which is the same derivation the exit-code mode seats.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {
	type FloorOptions,
	type FloorResolution,
	floorRefusalLine,
	NAMESPACE,
	resolveFloor,
	runFloor,
} from "./floor-verb.ts";
import {
	type CheckRunDraft,
	createCheckRun,
	latestPerContext,
	listShipCheckRuns,
	updateCheckRun,
	type WrittenCheckRun,
} from "./github.ts";
import {inspectedSha, NULL_TOKEN, resolveTargetRepo} from "./target.ts";

const VERB = "ship floor --publish-check";

/**
 * The check-run's name, which is what a branch-protection rule names as a required status check.
 *
 * Deliberately not the job's name: two rows in one PR's check list called the same thing would be
 * unreadable, and a ruleset naming the job would go on binding the exit code this mode exists to
 * stop binding.
 */
export const CHECK_RUN_NAME = "governance floor at head";

/**
 * The floor word the payload carries — what was decided, beside how the check-run seats it.
 *
 * `batch` is the one word no diff produces: it is `ship floor-batch`'s answer about a merge-queue
 * batch ref, which carries no pull request to resolve a floor over (`./floor-batch.ts`).
 */
export type FloorWord = "n/a" | "satisfied" | "blocked" | "unresolved" | "batch";

/**
 * What to write, in the two shapes the platform distinguishes.
 *
 * `Pending` is the whole point of this mode and carries no conclusion, because a conclusion is what
 * completes a check-run.
 */
export type CheckPlan =
	| {
			readonly _tag: "Pending";
			readonly floor: FloorWord;
			readonly title: string;
			readonly summary: string;
	  }
	| {
			readonly _tag: "Concluded";
			readonly conclusion: "success" | "failure";
			readonly floor: FloorWord;
			readonly title: string;
			readonly summary: string;
	  };

/**
 * The conclusion map, whole, in one pure function — the acceptance criteria of #6161 read as a
 * table, so a reader checks it against them without tracing control flow.
 *
 * `absent` is the one row that stays pending. Every other blocking state has a verdict behind it,
 * and a verdict that is FAIL or bound to another head is a thing that went wrong rather than a thing
 * that has not happened. UNKNOWN concludes `failure` and never pending: a floor nobody could read is
 * not a floor still being read, and ADR 0092 gives it the same polarity as a refusal.
 */
export const planFor = (pr: number, resolution: FloorResolution): CheckPlan => {
	if (resolution._tag === "Unbound") {
		return {
			_tag: "Concluded",
			conclusion: "success",
			floor: "n/a",
			title: "The floor does not bind",
			summary: `#${pr}'s diff touches no governance root, so no ${NAMESPACE} verdict is owed. This is an answer about the diff, not a discharged verdict.`,
		};
	}
	if (resolution._tag === "Unresolved") {
		const reason = resolution.outcome.stderr.at(-1) ?? "the floor could not be resolved";
		return {
			_tag: "Concluded",
			conclusion: "failure",
			floor: "unresolved",
			title: "The floor could not be resolved",
			summary: `${reason}\n\nUNKNOWN never passes (ADR 0092), so this concludes failure rather than waiting.`,
		};
	}
	if (resolution.state === "pass") {
		return {
			_tag: "Concluded",
			conclusion: "success",
			floor: "satisfied",
			title: "The floor is discharged at this head",
			summary: `#${pr} carries an authorized ${NAMESPACE} PASS bound to ${resolution.sha}.`,
		};
	}
	if (resolution.state === "absent") {
		return {
			_tag: "Pending",
			floor: "blocked",
			title: "Waiting for a governance verdict at this head",
			summary: `${floorRefusalLine(pr, resolution.state, resolution.sha)}\n\nNothing is wrong yet — this check stays pending until the verdict lands, and \`fabrika governance post\` re-fires the job that turns it green.`,
		};
	}
	return {
		_tag: "Concluded",
		conclusion: "failure",
		floor: "blocked",
		title: `The governance verdict at this head is ${resolution.state}`,
		summary: floorRefusalLine(pr, resolution.state, resolution.sha),
	};
};

const draftFor = (plan: CheckPlan, headSha: string): CheckRunDraft =>
	plan._tag === "Pending"
		? {_tag: "Pending", name: CHECK_RUN_NAME, headSha, title: plan.title, summary: plan.summary}
		: {
				_tag: "Concluded",
				name: CHECK_RUN_NAME,
				headSha,
				conclusion: plan.conclusion,
				title: plan.title,
				summary: plan.summary,
			};

/**
 * What {@link publishFloorCheck} did, in the two shapes its caller routes on.
 *
 * The rendering stays outside: the two callers print different line grammars over the same write —
 * the PR mode carries the resolved `governance` row, `ship floor-batch` has no namespace to report —
 * and folding both in would put a second answer about the floor inside the thing that only publishes.
 */
export type Publication =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Written"; readonly written: WrittenCheckRun; readonly rewritten: boolean};

/**
 * Write one {@link CheckPlan} to a head as the `governance floor at head` check-run.
 *
 * Shared by the PR mode and `./floor-batch.ts` so the name, the one-row-per-head invariant and the
 * read-back have one implementation. A branch protection matches a required context by name, so two
 * copies of this drifting apart is a frozen merge queue rather than a cosmetic difference (#6968).
 */
export const publishFloorCheck = (
	verb: string,
	repo: string,
	headSha: string,
	plan: CheckPlan,
	relayed: ReadonlyArray<string>,
): Effect.Effect<Publication, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		// A check-run this head already carries is rewritten rather than duplicated, so the PR shows
		// one row per head instead of a column of superseded ones. The exception is the backwards
		// transition — a completed check-run being re-opened as pending — which the platform does not
		// model: a `conclusion` already set is not cleared by an update, so that one posts a fresh run.
		const listed = yield* listShipCheckRuns(repo, headSha);
		if (listed._tag === "Failure") {
			// An unreadable list is not a head carrying no row: collapsing the two would post a second
			// check-run and quietly break the one-row-per-head invariant above. Every sibling reader of
			// this seam refuses here too (`ship checks`, `heal-ci surface`, `governance post`), so the
			// group holds one disposition for one read (#6161).
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot enumerate the check runs at ${headSha}: ${listed.reason} — nothing was published, so the floor stays UNKNOWN rather than posting a duplicate row.`,
					relayed,
				),
			};
		}
		const held =
			latestPerContext(listed.value.runs).find((run) => run.name === CHECK_RUN_NAME) ?? null;
		const rewritable = held !== null && !(held.status === "completed" && plan._tag === "Pending");

		const draft = draftFor(plan, headSha);
		const written = yield* rewritable && held !== null
			? updateCheckRun(repo, held.id, draft)
			: createCheckRun(repo, draft);
		if (written._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					WRITE_UNKNOWN,
					`${verb}: the check-run could not be written: ${written.reason} — the floor is resolved and nothing published it.`,
					relayed,
				),
			};
		}

		const expectedStatus = plan._tag === "Pending" ? "in_progress" : "completed";
		const expectedConclusion = plan._tag === "Pending" ? null : plan.conclusion;
		if (
			written.value.name !== CHECK_RUN_NAME ||
			written.value.status !== expectedStatus ||
			written.value.conclusion !== expectedConclusion
		) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					READBACK_MISMATCH,
					`${verb}: wrote ${expectedStatus}/${expectedConclusion ?? NULL_TOKEN} to check-run ${written.value.id} and GitHub echoed ${written.value.status}/${written.value.conclusion ?? NULL_TOKEN} — what the PR shows is not what this run decided.`,
					relayed,
				),
			};
		}

		return {_tag: "Written" as const, written: written.value, rewritten: rewritable};
	});

const stateOf = (resolution: FloorResolution): string =>
	resolution._tag === "Bound" ? resolution.state : NULL_TOKEN;

export const runFloorCheck = (
	options: FloorOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		// The head and the repository are resolved before the floor is, because they are what a
		// check-run is addressed to: without either there is nowhere to post the answer. Every non-zero
		// exit this mode has is a seat like that one — the answer was derived and something on the way
		// to publishing it was UNKNOWN. What the floor itself decided never reddens the job.
		const bound = inspectedSha(VERB, options.sha);
		if (typeof bound !== "string") return bound;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		// `resolveFloor` resolves the repository again, and that second call is a pass-through rather
		// than a second probe: it is handed the name this one already proved.
		const resolution = yield* resolveFloor({...options, repo});
		const plan = planFor(options.pr, resolution);
		const relayed =
			resolution._tag === "Unresolved" ? resolution.outcome.stderr : [...resolution.stderr];

		const published = yield* publishFloorCheck(VERB, repo, bound, plan, relayed);
		if (published._tag === "Refused") return published.outcome;
		const {written, rewritten} = published;

		const posted = `${VERB}: ${rewritten ? "rewrote" : "posted"} check-run ${written.id} — the job's own exit code no longer carries the floor (#6161).`;
		return answer(
			options.json
				? JSON.stringify({
						outcome: plan.floor,
						sha: bound,
						namespace: NAMESPACE,
						state: resolution._tag === "Bound" ? resolution.state : null,
						checkRun: {
							id: written.id,
							name: written.name,
							status: written.status,
							conclusion: written.conclusion,
						},
					})
				: `check\t${written.status}\t${written.conclusion ?? NULL_TOKEN}\t${written.id}\nfloor\t${plan.floor}\t${bound}\nns\t${NAMESPACE}\t${stateOf(resolution)}`,
			[...relayed, posted],
		);
	});

/**
 * Which of the two modes `--publish-check` selects, as a value rather than a branch inside the
 * command handler — the handler is the one surface no test in this package reaches, so a flag wired
 * to the wrong arm would ship green (#6161).
 */
export const floorRunner = (
	publishCheck: boolean,
): ((options: FloorOptions) => ReturnType<typeof runFloor>) =>
	publishCheck ? runFloorCheck : runFloor;
