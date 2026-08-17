/**
 * The chore drive's two closed tables: which recipe verb a chore state applies, and which one of the
 * machine's six events a run's exit records.
 *
 * This is `relay.ts`'s sibling one level up. `relay.ts` re-seats another *verb's* exit on this
 * group's table; this module re-seats this group's exit on the *machine's* event vocabulary — the
 * same discipline, because the operator that routes a chore lane holds no recipe knowledge and must
 * not compose one. Both halves are data with a pure reader, so `operate`'s chore drive is a relay
 * (ADR 0228) rather than a table restated in prose that drifts from the exits it describes.
 *
 * **Every exit lands on exactly one event.** A code with no row is `BLOCKED` and says so — the same
 * refusal-shaped default `relay.ts` takes, for the same reason: an exit this table has no reading
 * for has proven nothing, and the permissive reading of a code nobody seated is how a chore comes to
 * report a fix it never applied. `PARK_NOVEL` is the seat the founder's grill answer sits on (epic
 * #5840): it folds to `BLOCKED`, which every chore machine routes to a `human:` park, so novel
 * reaches a human by the machine's own cell rather than by an operator deciding to escalate.
 */
import type {OperatorEvent} from "../lane/machine.ts";
import {
	MALFORMED_RECORD,
	NOT_PARKED,
	NOTHING_TO_RERUN,
	PARK_HOLDS,
	PARK_NOVEL,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	RERUN_UNKNOWN,
	TARGET_ABSENT,
	TASK_UNRESOLVED,
	UNPARK_REFUSED,
	VERDICT_ABSENT,
	VERDICT_FAIL,
	VERDICT_STALE,
	WRITE_UNKNOWN,
} from "./codes.ts";

/** The verbs this group ships, and the only things a chore state may route to. */
export const RECIPE_VERBS = ["unpark", "rerun"] as const;

export type RecipeVerb = (typeof RECIPE_VERBS)[number];

/**
 * What the state's recipe is pointed at — a lane key, or a pull-request number.
 *
 * The operator carries no other way to know what argument to pass, and guessing it is how a chore
 * comes to run its recipe against the wrong artifact.
 */
export type RecipeTarget = "lane" | "pull";

export interface RecipeRoute {
	/** The chore-lane leaf state this row routes. */
	readonly state: string;
	readonly verb: RecipeVerb;
	readonly target: RecipeTarget;
	/** What the state's run does, in one clause the operator can print rather than compose. */
	readonly summary: string;
}

/**
 * The state → recipe table, the chore-lane counterpart of `wire/lane-brief.ts`'s state → shell one.
 *
 * A chore state routes to a whole recipe, not to a stage of one: `recipe unpark` classifies, clears
 * and reads the clear back inside a single invocation, so the machine holds one state for it and the
 * verb owns the sequence (ADR 0228). Splitting it back into per-stage states would put the recipe's
 * order in the machine document, where two chores would then spell it differently.
 */
export const RECIPE_ROUTES: ReadonlyArray<RecipeRoute> = [
	{
		state: "unpark",
		verb: "unpark",
		target: "lane",
		summary:
			"clear the target lane's park when it matches the known-recipe table, and refuse untouched when it does not",
	},
	{
		state: "rerun",
		verb: "rerun",
		target: "pull",
		summary:
			"rerun the target pull request's failed runs at its live head, behind a governance PASS bound to that head",
	},
];

/**
 * The recipe a chore leaf state applies, or `null` for every state that applies none — `queued`, a
 * park, a final, a name nobody registered. `null` rather than a guess is what makes "run some verb
 * at an unrouted state" unwritable rather than merely discouraged.
 */
export const routeOf = (raw: string): RecipeRoute | null =>
	RECIPE_ROUTES.find((row) => row.state === raw.trim()) ?? null;

/** One exit's reading: the single machine event it records, and the sentence that justifies it. */
export interface Disposition {
	readonly event: OperatorEvent;
	readonly why: string;
}

const SUCCESS = 0;

const disposition = (event: OperatorEvent, why: string): Disposition => ({event, why});

/**
 * `recipe unpark`'s exits.
 *
 * Three readings carry the weight. `PARK_HOLDS` is `WIP` — the recipe matched and its clearing
 * condition is simply not met yet, so the chore stays on its own state and a later pass re-runs it;
 * recording `BLOCKED` there would route a human at a park the recipe already owns. `WRITE_UNKNOWN`
 * is `FAIL` because the machine's retry budget is exactly the answer to a write that did not land.
 * `READBACK_MISMATCH` is `BLOCKED` and never `FAIL`: the append landed and the re-fold disagrees, so
 * the lane has moved and retrying would append over a state nobody has read.
 */
const UNPARK_EXITS: Readonly<Record<number, Disposition>> = {
	[SUCCESS]: disposition(
		"DONE",
		"the park matched a known recipe and the re-fold proves the target lane left it",
	),
	[NOT_PARKED]: disposition(
		"DONE",
		"the target lane holds no park — the sweep found nothing to clear, which is a finished sweep",
	),
	[PARK_HOLDS]: disposition(
		"WIP",
		"a known recipe whose clearing condition is not met yet — nothing was written; re-run this state later",
	),
	[PARK_NOVEL]: disposition(
		"BLOCKED",
		"the park's cause is outside the recipe table and nothing was written — the machine routes it to a human",
	),
	[WRITE_UNKNOWN]: disposition(
		"FAIL",
		"the UNBLOCKED append did not land, so the clear is not recorded — the retry budget is the answer",
	),
	[MALFORMED_RECORD]: disposition(
		"BLOCKED",
		"a lane record was read in full and is not the shape — a human owns the record, not a retry",
	),
	[TARGET_ABSENT]: disposition(
		"BLOCKED",
		"the target lane, or the pull request its park waits on, is proven absent — there is nothing to act on",
	),
	[READBACK_MISMATCH]: disposition(
		"BLOCKED",
		"the append landed and the re-fold contradicts it — the target lane moved and needs a human",
	),
	[PRECONDITION_UNKNOWN]: disposition(
		"BLOCKED",
		"a precondition read failed, so nothing is proven in either direction — UNKNOWN is never a retry",
	),
	[TASK_UNRESOLVED]: disposition(
		"BLOCKED",
		"the recipe could not resolve which task the park sits on — the addressing is a human's to fix",
	),
	[UNPARK_REFUSED]: disposition(
		"BLOCKED",
		"the target machine refused the UNBLOCKED and its log is unappended — the target's state is a human's",
	),
};

/**
 * `recipe rerun`'s exits.
 *
 * Every verdict refusal is `BLOCKED` rather than `FAIL`: forming a verdict, re-forming it at this
 * head and repairing the pull request are all somebody's work, and none of them is a retry of the
 * rerun. `NOTHING_TO_RERUN` is `DONE` for the same reason `NOT_PARKED` is — a sweep that finds no
 * work is a finished sweep, not a failed one.
 */
const RERUN_EXITS: Readonly<Record<number, Disposition>> = {
	[SUCCESS]: disposition(
		"DONE",
		"every failed run at the head was rerequested and each rerun was proven by re-reading its run",
	),
	[NOTHING_TO_RERUN]: disposition(
		"DONE",
		"no run at this head concluded in failure — there was nothing to rerun",
	),
	[WRITE_UNKNOWN]: disposition(
		"FAIL",
		"the rerun request did not land, so nothing is rerequested — the retry budget is the answer",
	),
	[TARGET_ABSENT]: disposition(
		"BLOCKED",
		"the pull request is proven absent or closed — there is nothing to act on",
	),
	[READBACK_MISMATCH]: disposition(
		"BLOCKED",
		"the request landed and the run's re-read shows no new attempt — the run needs a human",
	),
	[PRECONDITION_UNKNOWN]: disposition(
		"BLOCKED",
		"a precondition read failed, so the verdict state is UNKNOWN — never read as a PASS",
	),
	[VERDICT_ABSENT]: disposition(
		"BLOCKED",
		"the pull request carries no governance verdict — forming one is a reviewer's, not a retry",
	),
	[VERDICT_STALE]: disposition(
		"BLOCKED",
		"the latest governance verdict is bound to another head — re-forming it here is a reviewer's",
	),
	[VERDICT_FAIL]: disposition(
		"BLOCKED",
		"the governance verdict at the head is FAIL — repairing the pull request is a builder's",
	),
	[RERUN_UNKNOWN]: disposition(
		"BLOCKED",
		"the rerun was requested and its outcome could not be re-read — UNKNOWN in both directions",
	),
};

const EXITS: Readonly<Record<RecipeVerb, Readonly<Record<number, Disposition>>>> = {
	unpark: UNPARK_EXITS,
	rerun: RERUN_EXITS,
};

/**
 * The reading a code with no row gets. `BLOCKED`, never a permissive default: an exit this table has
 * no seat for has established nothing, and a chore that recorded `DONE` on it would report a fix it
 * never applied.
 */
export const unseated = (verb: RecipeVerb, code: number): Disposition =>
	disposition(
		"BLOCKED",
		`fabrika recipe ${verb} exited ${code}, which this table has no reading for — nothing is proven, so it routes to a human`,
	);

/** The one machine event a recipe run's exit records. Total: every code is seated or unseated. */
export const dispositionOf = (verb: RecipeVerb, code: number): Disposition =>
	EXITS[verb][code] ?? unseated(verb, code);

/** The codes a verb seats, for a test to hold the table closed against `codes.ts`. */
export const seatedExits = (verb: RecipeVerb): ReadonlyArray<number> =>
	Object.keys(EXITS[verb]).map((key) => Number.parseInt(key, 10));
