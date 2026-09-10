/**
 * How long one shell may hold a lane before the shell driving it is judged dead.
 *
 * **There is no heartbeat, and that is the ruling rather than an omission** — see ADR 0373, which
 * also narrows the claim protocol's age ban to the one caller that reads these numbers against a
 * claim marker. A spawned shell writes
 * nothing between its claim and its terminal, so liveness is not observable at all: the only instant
 * on disk is the one the work began at. What is left to judge against is a budget — how long this
 * kind of work takes when it is going well — and silence past that budget is the death.
 *
 * The budget is therefore **per kind of work**. One horizon for the whole pipeline is the shape this
 * module replaces, and it is wrong in both directions at once: wide enough for a builder's
 * construct-check loop, it strands a dead shipper's claim for the better part of an hour; tight
 * enough for a shipper, it evicts a live builder mid-loop. Each shell state names its own number and
 * records, at the number, what shape of work the number is measuring.
 *
 * The three values are the founder's starting guesses, and they are guesses on purpose: nobody has
 * measured these loops yet, so the honest derivation is the *shape* of each shell's work, and the
 * numbers are tuned in the weekly machinery review beside the machinery-lap budget. What the shape
 * fixes and tuning may not break is the ordering — a builder writes and re-validates, a reviewer
 * reads once and records a verdict, a shipper walks a guard chain and enqueues — so
 * `build > review > ship` holds however the numbers move.
 */
import {type ShellState, shellState} from "../wire/lane-brief.ts";

/** One kind of work's horizon, with the shape of the work that horizon is measuring. */
export interface ShellBudget {
	readonly minutes: number;
	/** Why this kind of work gets this horizon — the derivation, written where the number is. */
	readonly why: string;
}

/**
 * The horizon per shell state.
 *
 * A UI variant takes its text kind's number because it is the same shape of work with a rendered
 * surface in it: `build:ui` still loops construct → check, `review:ui` still reads once and records.
 * A number of its own would be a claim about rendering time nobody has measured.
 */
export const SHELL_BUDGETS: Readonly<Record<ShellState, ShellBudget>> = {
	build: {
		minutes: 40,
		why: "a builder loops construct → check until the validators go green, so its horizon covers several full validator passes over a tree it is still changing",
	},
	"build:ui": {
		minutes: 40,
		why: "the same construct → check loop as a text build, with a rendered surface inside it rather than a differently-shaped job",
	},
	review: {
		minutes: 15,
		why: "a reviewer reads one range once and records a verdict — no loop, and nothing it does can send it back to the start",
	},
	"review:ui": {
		minutes: 15,
		why: "the same single read-and-record pass as a text review, over a rendered surface rather than a diff",
	},
	ship: {
		minutes: 10,
		why: "a shipper walks a fixed guard chain and enqueues — the shortest of the three, and the wait it hands off to is the queue's, recorded as a wait rather than held open here",
	},
};

/**
 * The horizon for a task that routes to no shell — a `queued` task nobody has dispatched.
 *
 * Its own row rather than a shell's, because what it measures is not work at all: it is the gap
 * between a task becoming dispatchable and a driver dispatching it, and a driver's own loop is far
 * shorter than any shell's.
 */
export const DISPATCH_BUDGET: ShellBudget = {
	minutes: 10,
	why: "nothing is working — this is the gap between a task becoming dispatchable and a driver dispatching it, which is one pass of the driver's own loop",
};

/**
 * The horizon a lane is judged against, in minutes.
 *
 * The **maximum** over the leaves that route to a shell: a lane driving a builder and a reviewer at
 * once is alive as long as the longest-running of them may still be working, and taking the minimum
 * would call the whole lane dead on the shortest budget in it. A lane whose driven leaves route to
 * no shell at all is waiting on a dispatch, so it takes {@link DISPATCH_BUDGET}.
 */
export const budgetMinutesFor = (leaves: ReadonlyArray<string>): number => {
	const budgets = leaves.flatMap((leaf) => {
		const state = shellState(leaf);
		return state === null ? [] : [SHELL_BUDGETS[state].minutes];
	});
	return budgets.length === 0 ? DISPATCH_BUDGET.minutes : Math.max(...budgets);
};

/**
 * The horizon a build claim is judged against.
 *
 * A claim marker names the shell that took it through its namespace, and the `build` namespace is
 * the builder's — so a stranded `build-claim` is judged against the builder's own budget rather than
 * against whichever state the lane happens to be parked in now.
 */
export const BUILD_CLAIM_BUDGET_MINUTES = SHELL_BUDGETS.build.minutes;

/**
 * Whether the shell that started work at an instant is still inside its budget.
 *
 * `Unreadable` is its own arm rather than either edge: an instant that does not parse gives an age
 * nobody can compute, and resolving it to `Live` would hide a stranded claim forever while resolving
 * it to `Dead` would evict a shell on a fact nobody read. A clock that ran backwards floors at age
 * zero, which reads `Live` — the fail-safe direction, since the cost of waiting is a lap and the
 * cost of a wrong eviction is a live shell's work.
 */
export type Liveness =
	| {readonly _tag: "Dead"; readonly ageMinutes: number; readonly budgetMinutes: number}
	| {readonly _tag: "Live"; readonly ageMinutes: number; readonly budgetMinutes: number}
	| {readonly _tag: "Unreadable"; readonly reason: string};

export const livenessOf = (
	startedAt: string,
	nowEpochMs: number,
	budgetMinutes: number,
): Liveness => {
	const startedEpochMs = Date.parse(startedAt);
	if (Number.isNaN(startedEpochMs)) {
		return {
			_tag: "Unreadable",
			reason: `"${startedAt}" is not an instant to measure a shell's age from`,
		};
	}
	const ageMinutes = Math.max(0, Math.floor((nowEpochMs - startedEpochMs) / 60_000));
	return ageMinutes >= budgetMinutes
		? {_tag: "Dead", ageMinutes, budgetMinutes}
		: {_tag: "Live", ageMinutes, budgetMinutes};
};
