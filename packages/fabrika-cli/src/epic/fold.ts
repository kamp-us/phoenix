/**
 * The fold: recorded events + git facts → one per-slice state, and one next action.
 *
 * `epic next` and `epic status` are the same derivation read two ways, which is why it lives here
 * once. Nothing below stores state; every value is recomputed from the ledger and the live graph on
 * every call, so a verdict whose commit left the graph surfaces as `unbindable` rather than as a
 * remembered pass (ADR 0058's shape, via the binding the SHA carries).
 *
 * **Two orderings differ from the contract's listed arm order, both because the listed one makes an
 * arm unreachable.** `halted` is evaluated first — the contract's own "this arm outranks everything
 * after it" is otherwise satisfied by an arm that every non-passed slice masks — and `done` is
 * evaluated before `open-pr`, because a run whose `pr-opened` is recorded still has every slice
 * PASS-bound and would otherwise be told to open the PR a second time. Every other arm is in the
 * contract's order.
 */
import {CLAUSE_SEPARATOR} from "../wire/verdict-marker.ts";
import {
	type BreakerAxis,
	boundShaOf,
	countersFor,
	forSlice,
	type LedgerLine,
	polarityOf,
	type SliceCounters,
	trippedAxis,
} from "./ledger.ts";
import type {RunPlan} from "./run.ts";

/** The git facts the fold reads, resolved by the verb so the derivation itself stays pure. */
export interface GraphFacts {
	readonly head: string | null;
	/** SHAs proven present in this branch's local graph. */
	readonly present: ReadonlySet<string>;
	/** SHAs proven to be ancestors of HEAD — history extended, not rewritten. */
	readonly ancestors: ReadonlySet<string>;
}

/** The derived per-slice vocabulary, closed. */
export type SliceState =
	| "pending"
	| "dispatched"
	| "landed"
	| "passed"
	| "retrying"
	| "escalated"
	| "dead-dispatch";

/** The verdict, four-valued against the live graph. `unbindable` never renders as `current`. */
export type VerdictState = "current" | "fail" | "none" | "unbindable";

export interface SliceFold {
	readonly id: string;
	readonly issue: number;
	readonly state: SliceState;
	readonly verdict: VerdictState;
	readonly counters: SliceCounters;
	readonly axis: BreakerAxis | null;
	/** The commit the latest `slice-landed` captured, or `null` while nothing has landed. */
	readonly commit: string | null;
	/** The opening SHA of a dispatch with no landing or death recorded after it. */
	readonly openSha: string | null;
	/** Whether the latest verdict grades the slice's latest landing. */
	readonly verdictIsCurrent: boolean;
	/** The FAIL verdict's first line — what a retry brief injects as Fix-First. */
	readonly fixFirst: string | null;
}

/**
 * The clause out of a recorded verdict marker.
 *
 * Read here rather than through `verdict-marker.read` on purpose: that read's namespace grammar is
 * `review` / `review-<gate>`, and a slice verdict's namespace is `slice:<id>` by contract, so the
 * total read would answer `Malformed` for every well-formed slice marker. The separator constant is
 * imported so the two spellings cannot drift apart.
 */
export const clauseOf = (line: LedgerLine): string | null => {
	const index = (line.detail ?? "").indexOf(CLAUSE_SEPARATOR);
	if (index === -1) return null;
	const clause = (line.detail ?? "").slice(index + CLAUSE_SEPARATOR.length).trim();
	return clause === "" ? null : clause;
};

const latest = (lines: ReadonlyArray<LedgerLine>, event: LedgerLine["event"]): LedgerLine | null =>
	lines.filter((line) => line.event === event).at(-1) ?? null;

export const foldSlice = (
	lines: ReadonlyArray<LedgerLine>,
	slice: {readonly id: string; readonly issue: number},
	graph: GraphFacts,
): SliceFold => {
	const own = forSlice(lines, slice.id);
	const counters = countersFor(lines, slice.id);
	const axis = trippedAxis(counters);

	const dispatched = latest(own, "slice-dispatched");
	const landed = latest(own, "slice-landed");
	const dead = latest(own, "dispatch-dead");
	const verdict = latest(own, "verdict-recorded");

	const closedBy = Math.max(landed?.seq ?? 0, dead?.seq ?? 0);
	const openSha =
		dispatched !== null && dispatched.seq > closedBy ? (dispatched.sha ?? null) : null;

	const boundSha = verdict === null ? null : boundShaOf(verdict);
	const polarity = verdict === null ? null : polarityOf(verdict);
	const verdictIsCurrent = verdict !== null && verdict.seq > (landed?.seq ?? 0);
	const verdictState: VerdictState =
		verdict === null
			? "none"
			: boundSha === null || !graph.present.has(boundSha)
				? "unbindable"
				: polarity === "FAIL"
					? "fail"
					: "current";

	const state: SliceState =
		axis !== null
			? "escalated"
			: verdictIsCurrent && verdictState === "current"
				? "passed"
				: verdictIsCurrent && verdictState === "fail"
					? "retrying"
					: dead !== null && dead.seq > Math.max(dispatched?.seq ?? 0, landed?.seq ?? 0)
						? "dead-dispatch"
						: landed !== null
							? "landed"
							: dispatched !== null
								? "dispatched"
								: "pending";

	return {
		id: slice.id,
		issue: slice.issue,
		state,
		verdict: verdictState,
		counters,
		axis,
		commit: landed?.sha ?? null,
		openSha,
		verdictIsCurrent,
		fixFirst: polarity === "FAIL" && verdict !== null ? clauseOf(verdict) : null,
	};
};

/** Every slice of the run, folded in the plan's topological order. */
export const foldRun = (
	plan: RunPlan,
	lines: ReadonlyArray<LedgerLine>,
	graph: GraphFacts,
): ReadonlyArray<SliceFold> =>
	plan.order.flatMap((id) => {
		const slice = plan.slices.find((row) => row.id === id);
		return slice === undefined ? [] : [foldSlice(lines, slice, graph)];
	});

/** The closed action set `epic next` answers with. */
export type NextAction =
	| {readonly action: "dispatch-slice"; readonly slice: string; readonly run: string}
	| {readonly action: "evaluate-slice"; readonly slice: string; readonly commit: string}
	| {
			readonly action: "retry-slice";
			readonly slice: string;
			readonly attempt: number;
			readonly fixFirst: string;
	  }
	| {
			readonly action: "escalate-slice";
			readonly slice: string;
			readonly axis: BreakerAxis;
			readonly attempts: number;
	  }
	| {readonly action: "open-pr"; readonly epic: number}
	| {readonly action: "done"; readonly epic: number}
	| {readonly action: "halted"; readonly reason: string};

const escalate = (fold: SliceFold, axis: BreakerAxis): NextAction => ({
	action: "escalate-slice",
	slice: fold.id,
	axis,
	attempts: axis === "fail" ? fold.counters.failAttempts : fold.counters.deadAttempts,
});

/**
 * One next action, folded from the ledger and the graph.
 *
 * The first arm is the contract's "a slice dispatched but not landed → verify before anything else",
 * discharged **here** rather than deferred to the caller: this verb reads the graph, so it answers
 * the landing question itself. A dispatch the graph proves produced nothing is the dead-dispatch
 * case — the slice is dispatched again under the dead axis, which is what `epic landed`'s `22` gives
 * the conductor the proof to record.
 */
export const nextAction = (
	plan: RunPlan,
	lines: ReadonlyArray<LedgerLine>,
	graph: GraphFacts,
	run: string,
): NextAction => {
	if (lines.some((line) => line.event === "run-halted")) {
		return {action: "halted", reason: "run-halted recorded"};
	}

	for (const fold of foldRun(plan, lines, graph)) {
		if (fold.state === "passed") continue;

		if (fold.openSha !== null) {
			const landedNow =
				graph.head !== null && graph.head !== fold.openSha && graph.ancestors.has(fold.openSha);
			if (landedNow && graph.head !== null) {
				return {action: "evaluate-slice", slice: fold.id, commit: graph.head};
			}
			if (fold.axis !== null) return escalate(fold, fold.axis);
			return {action: "dispatch-slice", slice: fold.id, run};
		}
		if (fold.axis !== null) return escalate(fold, fold.axis);
		if (fold.commit !== null && !fold.verdictIsCurrent) {
			return {action: "evaluate-slice", slice: fold.id, commit: fold.commit};
		}
		if (fold.verdictIsCurrent && fold.verdict === "fail") {
			return {
				action: "retry-slice",
				slice: fold.id,
				attempt: fold.counters.failAttempts + 1,
				fixFirst: fold.fixFirst ?? "",
			};
		}
		return {action: "dispatch-slice", slice: fold.id, run};
	}

	if (lines.some((line) => line.event === "pr-opened")) return {action: "done", epic: plan.epic};
	return {action: "open-pr", epic: plan.epic};
};

/** A slice whose breaker is tripped, for the acting verbs' `23` refusal. */
export const breakerFor = (lines: ReadonlyArray<LedgerLine>, slice: string): BreakerAxis | null =>
	trippedAxis(countersFor(lines, slice));
