/**
 * The pure epic-machine emitter — one epic body plus its child links in, one `workflow.json` text
 * out, byte-deterministic.
 *
 * **No second grammar and no second cycle walk.** The topology is read through
 * `ledger/topology-doc.ts`'s `readDeclared`, which parses with the shipped `build/dependencies.ts`
 * parser — the same reader `build check --surface plan` validates with, while `build eligible` gates
 * on the native `blocked_by` graph instead — restricts what it read to the epic's live children, and
 * carries the `dropForeign` axis `ledger retopology` reads too; the cycle check is that same
 * module's `findCycle` over the union graph (declared `requires` edges
 * plus the edges the phase order implies). What this module adds is only the machine rendering:
 * one region per child, phases sequenced by `onDone`, parallel within a phase, and one epic tail
 * phase after the last of them.
 *
 * **One epic run is one branch and one PR**. A child's region is the local loop only —
 * `queued → build → review → integrate`, the integrate step merging the child's range into the epic
 * branch — and the merge to `main` lives once, in the tail phase's single epic-level region
 * (`review → ship → shipped`, plus the `build` repair cell a failed tail review retries into). The
 * tail is a *phase* rather than a bare state because `machine.ts` reads the workflow's two terminals
 * off the last phase's `onDone` pair; shaped this way the compiler needs no change at all.
 *
 * Determinism is by construction: phases ascend, children within a phase ascend, every object's
 * keys are inserted in one fixed order, and the serialization is a single `JSON.stringify` — the
 * same body bytes and the same child links (each child's number, state and close reason) can only
 * produce the same machine bytes. A child's state is part of the input: a closed child boots its
 * region in a final state, so re-emitting a partly-built epic yields a machine that can still
 * terminate.
 *
 * The machinery lap axis rides one boolean, off by default (`machineryLaps.onEmit`): on, each task
 * seeds a lap counter and the collision and queue states take a `LAP` arm; off, every byte is what
 * it was before the axis existed. The machine is fixed at emission, so the flag reaches no lane
 * already on disk.
 *
 * The class axis rides each child's own `classes`, off the `sub_issues` payload's labels: a classed
 * child seeds `context.<task>.classes` and takes the class-guarded arm, an unclassed one is the
 * bytes it always was ([`class-seed.ts`](class-seed.ts) carries why that seed matters). Same
 * fixed-at-emission rule — a class stamped after the emit reaches this machine only through an
 * event.
 */
import {findCycle, readDeclared} from "../ledger/topology-doc.ts";
import type {SubIssueLink} from "../plan/github.ts";
import {MACHINERY_LAP_BUDGET, RETRY_BUDGET} from "../retry-budget.ts";

export type EmitResult =
	| {
			readonly _tag: "Emitted";
			readonly text: string;
			/** The child phases the topology declares. The machine also carries the epic tail phase. */
			readonly phases: number;
			readonly children: number;
			/** The refs `dropForeign` took out of the topology, in the order the block names them. */
			readonly dropped: ReadonlyArray<string>;
	  }
	| {readonly _tag: "NoTopology"}
	| {readonly _tag: "Unparseable"; readonly line: number; readonly text: string}
	| {readonly _tag: "Foreign"; readonly ref: string}
	| {readonly _tag: "Duplicate"; readonly child: number}
	| {readonly _tag: "Unplaced"; readonly child: number}
	/** `dropForeign` emptied the topology — every ref it placed is a non-child. */
	| {readonly _tag: "Emptied"; readonly dropped: ReadonlyArray<string>}
	| {readonly _tag: "Cycle"; readonly path: ReadonlyArray<number>};

/**
 * Where a child's region boots. Only a `completed` close asserts the work landed, so only it earns
 * `landed`; every other close (`not_planned`, `duplicate`, a legacy null reason) is
 * closed-without-landing and boots `frozen` — a final carrying a door, which the compiler reads as
 * this region's error final because the region BOOTS there, and the phase trips. That is the loud
 * answer for a topology that still requires a child the board abandoned; marking it `landed` would
 * fabricate a landing instead. A child booted there left no state behind it, so `frozen`'s
 * `UNBLOCKED` door has nowhere to resume to and the fold refuses it — that child is re-emitted, not
 * unfrozen.
 */
const initialFor = (link: SubIssueLink): "queued" | "landed" | "frozen" => {
	if (link.state === "open") return "queued";
	return link.stateReason === "completed" ? "landed" : "frozen";
};

/**
 * The rendered-surface class and the guard spelling that routes on it — the same two strings the
 * committed coder template carries, so a child region and a single-issue lane read one grammar.
 *
 * A child carrying the class gets the `build:ui` construction cell and the guarded arms into it; a
 * child carrying none is emitted byte-for-byte as it was before this axis existed.
 *
 * **The rendered REVIEW cell is deliberately not emitted**, on the decision record that rules an
 * epic child's rendered review the tail's by construction. A child opens no pull request, so a
 * `review:ui` cell it entered could produce nothing: `wire/lane-brief.ts` maps the state to
 * `ui-reviewer` with no child arm, and `prove.ts`'s `claimOf` gates its `PASS` on `&& !child`.
 */
const UI_CLASS = "ui";
const UI_GUARD = `class:${UI_CLASS}`;

/**
 * The machinery arm, whose two targets are the whole of the lap axis in a document: go round again
 * while laps remain, else park on `human:machinery-stall`.
 *
 * The park is a plain state with an `UNBLOCKED` door rather than a final, because a spent lap is not
 * a verdict against the work — nothing about the artifact is wrong, the pipeline failed to carry it
 * — so freezing the task would tell a reader the opposite of what happened.
 */
const lapArm = (target: string): ReadonlyArray<Record<string, unknown>> => [
	{target, guard: "lapsRemaining", actions: "incrementLaps"},
	{target: "human:machinery-stall"},
];

/**
 * One child's region — the local loop, namespaced to the child's task id.
 *
 * It ends at `landed`: the child's commits are on the epic's shared branch and nothing was pushed,
 * reviewed on GitHub or merged. There is no per-child `ship` and no per-child `human:cp-approval`
 * because there is no per-child PR to ship or to gate.
 *
 * `integrate` is the merge of the reviewed range into the epic branch, and it is a *state* so that a
 * collision between two children resolves inside the run: its `FAIL` — a textual conflict, or a
 * failed post-merge check, which is the semantic collision — re-enters `build` under the same
 * guarded-FAIL retry array `review` uses, and exhausts into `human:budget-spent` — a park with an
 * `UNBLOCKED` door back to the state it left, spent retries held. No route from it reaches a
 * merge queue, and none reaches `landed` without passing back through `review`: post-resolution
 * content is not what the range verdict judged, so the verdict is re-proven before the landing
 * rather than after it.
 *
 * Its `WIP` is the door that keeps that second half true when the verb resolves the collision
 * itself. `lane integrate`'s replay puts a colliding child's commits down on the assembly tip, so
 * the graded range moves and a verdict bound to the old range no longer describes what would land —
 * the run says as much in `reReview: "required"`. Without an arm out of `integrate` the only move
 * toward progress was the `DONE` into `landed`, which ends the child on content no reviewer read.
 *
 * That arm is a guarded array like `ship:queued`'s, not the plain target it was first written as: a
 * replay is machinery working rather than the child failing, so it spends `waits` and never a repair
 * round, which is the whole of `budget: "unspent"`. Spending nothing at all is the shape that was
 * wrong — `integrate --WIP--> review --PASS--> integrate` is a closed cycle, and a plain target sits
 * in no wait park, so nothing counted its turns. Its spent-budget fallthrough is
 * `human:replay-stall` rather than `human:budget-spent` because a replay that will not settle is a
 * collision between two children a person reads, not a child that failed its review. Its own row in
 * `report.ts`'s `STRUCTURAL_PARK_CAUSES` is what keeps it a door rather than a dead end: a `WIP`
 * may carry no `--cause`, so without one the leaf folds causeless, `routeForCause` reads `founder`
 * and `recipe unpark` refuses it forever — a machinery failure spending a person, which is the whole
 * defect this region was rewritten to remove.
 *
 * `frozen` survives as the boot state {@link initialFor} seats an abandoned child in, and nothing
 * transitions into it any more: a spent repair budget lands on `human:budget-spent` instead, which
 * is the SAME shape — a `final` carrying an `UNBLOCKED` door, so the phase folds and the lane trips
 * loud — under a name `recipe/parks.ts` can see. `isPark` matches `blocked` and `human:*` and
 * matched `frozen` never, so a child at its cap parked where every recipe answered `NotParked`.
 *
 * A `ui`-classed child carries one more state — `build:ui` — and the guarded `queued.WIP` arm into
 * it, so its first construction pass runs in the rendered shell. Without that pair the class seed
 * reached an emitted child and turned nothing, the half of this axis a folded report named from the
 * other end. The template's `review:ui` cell has no counterpart here, for the reason
 * {@link UI_CLASS} carries; a `review` FAIL therefore retries in `build` on every child alike,
 * because a two-arm guarded array holds one guard and this one spends the repair budget.
 */
const region = (
	ns: string,
	initial: "queued" | "landed" | "frozen",
	machinery: boolean,
	classes: ReadonlyArray<string>,
): Record<string, unknown> => {
	const ui = classes.includes(UI_CLASS);
	return {
		initial,
		states: {
			queued: {
				on: {
					[`${ns}.WIP`]: ui ? [{target: "build:ui", guard: UI_GUARD}, {target: "build"}] : "build",
					[`${ns}.BLOCKED`]: "blocked",
				},
			},
			build: {on: {[`${ns}.DONE`]: "review", [`${ns}.BLOCKED`]: "blocked"}},
			...(ui ? {"build:ui": {on: {[`${ns}.DONE`]: "review", [`${ns}.BLOCKED`]: "blocked"}}} : {}),
			review: {
				on: {
					[`${ns}.PASS`]: "integrate",
					[`${ns}.BLOCKED`]: "blocked",
					[`${ns}.FAIL`]: [
						{target: "build", guard: "retriesRemaining", actions: "incrementRetries"},
						{target: "human:budget-spent"},
					],
				},
			},
			integrate: {
				on: {
					[`${ns}.DONE`]: "landed",
					[`${ns}.WIP`]: [
						{target: "review", guard: "waitsRemaining", actions: "incrementWaits"},
						{target: "human:replay-stall"},
					],
					[`${ns}.BLOCKED`]: "blocked",
					[`${ns}.FAIL`]: [
						{target: "build", guard: "retriesRemaining", actions: "incrementRetries"},
						{target: "human:budget-spent"},
					],
					...(machinery ? {[`${ns}.LAP`]: lapArm("review")} : {}),
				},
			},
			blocked: {on: {[`${ns}.UNBLOCKED`]: "hist"}},
			"human:replay-stall": {on: {[`${ns}.UNBLOCKED`]: "hist"}},
			"human:budget-spent": {type: "final", on: {[`${ns}.UNBLOCKED`]: "hist"}},
			...(machinery ? {"human:machinery-stall": {on: {[`${ns}.UNBLOCKED`]: "hist"}}} : {}),
			hist: {type: "history"},
			landed: {type: "final"},
			frozen: {type: "final", on: {[`${ns}.UNBLOCKED`]: "hist"}},
		},
	};
};

/**
 * The epic's own region — the tail phase's single task: review the one PR, then merge it once, with
 * one `build` cell behind the review for the repair a failed tail owes.
 *
 * `ship` carries the same guarded FAIL, because a PR can be re-reviewed at a rewritten head while
 * the lane sits there and a park clear is exactly that path. Its retry arm stays `review`: a shipper
 * fails on the PR's own mergeability, which the next verdict over the same head answers.
 *
 * `ship:queued` is the tail's wait cell: the tail is the one place an epic run meets a
 * merge queue, so it is the one region that needs it — a child region has no `ship` and reaches no
 * queue at all. The `WIP` out of it is a guarded array like the FAIL above, but it spends `waits`
 * rather than `retries`, so a queue dwell cannot eat the epic review's repair rounds. Its spent-
 * budget fallthrough is `human:queue-stall` and not `human:cp-approval` because a `WIP` carries no
 * park cause, and `recipe/parks.ts`'s §CP row keys on `cause: null` — a stall landing there would be
 * cleared by reading an approval nobody was waiting on. Its own leaf carries no row, so the table
 * reads it as novel and routes it to a human, which is what a spent wait actually needs.
 *
 * `review` FAIL is a two-arm guarded array so the fallthrough final is an *error* final by the
 * compiler's own structural read; a plain target would leave a failed epic review folding to
 * `complete`. Its retry arm is `build` — the tail's own repair cell, carrying the child region's two
 * edges — because the facts a tail review fails on (a trunk conflict against a moved `main`, a head
 * with no CI) are a builder's to fix and no reviewer can change them: aimed back at `review` the arm
 * re-dispatched the shell that had just produced the verdict, spent the round and reached the park
 * anyway (the 2026-08-20 amendment to the epic-machine decision record). The fallthrough is the same `human:budget-spent` a
 * child's is: an epic review that spent its budget is a park its driver resumes, not the end of the
 * run, and one leaf for one fact means one route to read it by.
 */
const epicRegion = (ns: string, machinery: boolean): Record<string, unknown> => ({
	initial: "review",
	states: {
		build: {on: {[`${ns}.DONE`]: "review", [`${ns}.BLOCKED`]: "blocked"}},
		review: {
			on: {
				[`${ns}.PASS`]: "ship",
				[`${ns}.BLOCKED`]: "blocked",
				[`${ns}.FAIL`]: [
					{target: "build", guard: "retriesRemaining", actions: "incrementRetries"},
					{target: "human:budget-spent"},
				],
			},
		},
		ship: {
			on: {
				[`${ns}.DONE`]: "shipped",
				[`${ns}.WIP`]: "ship:queued",
				[`${ns}.BLOCKED`]: "human:cp-approval",
				[`${ns}.FAIL`]: [
					{target: "review", guard: "retriesRemaining", actions: "incrementRetries"},
					{target: "human:budget-spent"},
				],
				...(machinery ? {[`${ns}.LAP`]: lapArm("ship")} : {}),
			},
		},
		"ship:queued": {
			on: {
				[`${ns}.DONE`]: "shipped",
				[`${ns}.BLOCKED`]: "human:cp-approval",
				[`${ns}.WIP`]: [
					{target: "ship:queued", guard: "waitsRemaining", actions: "incrementWaits"},
					{target: "human:queue-stall"},
				],
				[`${ns}.FAIL`]: [
					{target: "review", guard: "retriesRemaining", actions: "incrementRetries"},
					{target: "human:budget-spent"},
				],
				...(machinery ? {[`${ns}.LAP`]: lapArm("ship")} : {}),
			},
		},
		blocked: {on: {[`${ns}.UNBLOCKED`]: "hist"}},
		"human:cp-approval": {on: {[`${ns}.UNBLOCKED`]: "hist"}},
		"human:queue-stall": {on: {[`${ns}.UNBLOCKED`]: "hist"}},
		...(machinery ? {"human:machinery-stall": {on: {[`${ns}.UNBLOCKED`]: "hist"}}} : {}),
		hist: {type: "history"},
		shipped: {type: "final"},
		"human:budget-spent": {type: "final", on: {[`${ns}.UNBLOCKED`]: "hist"}},
	},
});

/**
 * A child's task id in its parent epic's machine — the one spelling, read back by
 * [`child-membership.ts`](child-membership.ts) when `lane open` asks whether the parent lane
 * actually holds a task for a child the board links to it.
 */
export const childTaskId = (child: number): string => `issue_${child}`;

/**
 * The child number a task id names, or `null` where the id is not a child's.
 *
 * The epic tail's `epic_<n>` and any hand-written id answer `null` rather than a plausible number,
 * which is what keeps a caller that has to reach the board — `lane amend --defer`, asking whether a
 * live worker owns the child — from reading an ownership answer about the wrong issue.
 */
export const taskIdChild = (task: string): number | null => {
	const matched = /^issue_(\d+)$/.exec(task);
	const digits = matched?.[1];
	if (digits === undefined) return null;
	const parsed = Number(digits);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * One task's seeded context. The lap pair and the classes are appended rather than interleaved, so
 * an emission with the axis off and no class is the object it always was — key order included, which
 * is what makes the byte comparison a test can hold.
 *
 * An unclassed task carries no `classes` key at all rather than an empty array, for that same
 * reason: `machine.ts` reads a missing declaration and an empty one identically, so the key would
 * buy nothing and cost every existing emission's bytes.
 */
const taskContext = (
	machinery: boolean,
	classes: ReadonlyArray<string> = [],
): Record<string, unknown> => ({
	retries: 0,
	maxRetries: RETRY_BUDGET,
	...(machinery ? {laps: 0, maxLaps: MACHINERY_LAP_BUDGET} : {}),
	...(classes.length === 0 ? {} : {classes: [...classes]}),
});

/** The tail phase's name and its one task id. Neither can collide with a `phase<N>`/`issue_<n>`. */
const EPIC_PHASE = "epic";
const epicTaskId = (epic: number): string => `epic_${epic}`;

const ascending = (values: Iterable<number>): ReadonlyArray<number> =>
	[...values].sort((a, b) => a - b);

export interface EmitAxes {
	/** `machineryLaps.onEmit` — whether the emitted machine carries the machinery `LAP` arms. */
	readonly machinery?: boolean;
	/**
	 * Drop every topology ref the live child list does not name instead of refusing `Foreign`.
	 *
	 * Opt-in rather than the default, because the two readings of a foreign ref take opposite
	 * repairs: a descope means the board is right and the body is stale, a typo means the body meant
	 * a child and named the wrong number, and only the operator knows which they are looking at.
	 */
	readonly dropForeign?: boolean;
}

/** Emit the epic's lane machine from its body's `## Dependencies` block and its child links. */
export const emitMachine = (
	epic: number,
	body: string,
	children: ReadonlyArray<SubIssueLink>,
	axes: EmitAxes = {},
): EmitResult => {
	const machinery = axes.machinery === true;
	// Childlessness is read before the body, because an issue with no sub-issue links is not an epic
	// whatever its prose says — parsing first let a plain issue's `## Dependencies` heading refuse as
	// a malformed epic record and dead-end the boot.
	if (children.length === 0) return {_tag: "NoTopology"};

	const initials = new Map(children.map((link) => [link.number, initialFor(link)]));
	const classes = new Map(children.map((link) => [link.number, link.classes]));
	const classesOf = (child: number): ReadonlyArray<string> => classes.get(child) ?? [];
	const declared = readDeclared(body, new Set(initials.keys()), axes.dropForeign === true);
	if (declared._tag === "Absent") return {_tag: "NoTopology"};
	if (declared._tag !== "Declared") return declared;

	// Every line's child came out of the child set `readDeclared` restricted to, so the lookup holds
	// by construction; the throw is the invariant's enforcement site — a defaulted initial would
	// mis-seat a child.
	const initialOf = (child: number): "queued" | "landed" | "frozen" => {
		const initial = initials.get(child);
		if (initial === undefined) throw new Error(`no child link for #${child}`);
		return initial;
	};

	const cycle = findCycle(declared.lines);
	if (cycle !== null) return {_tag: "Cycle", path: cycle};

	const phases = new Map<number, number[]>();
	for (const line of declared.lines) {
		phases.set(line.phase, [...(phases.get(line.phase) ?? []), line.child]);
	}
	const order = ascending(phases.keys());
	const phaseName = (phase: number): string => `phase${phase}`;
	const context: Record<string, unknown> = {};
	const states: Record<string, unknown> = {};
	for (const [index, phase] of order.entries()) {
		const members = ascending(phases.get(phase) ?? []);
		for (const child of members) {
			context[childTaskId(child)] = taskContext(machinery, classesOf(child));
		}
		const next = order[index + 1];
		states[phaseName(phase)] = {
			type: "parallel",
			states: Object.fromEntries(
				members.map((child) => [
					childTaskId(child),
					region(childTaskId(child).toUpperCase(), initialOf(child), machinery, classesOf(child)),
				]),
			),
			onDone: [
				{target: next === undefined ? EPIC_PHASE : phaseName(next), guard: "noErrors"},
				{target: "tripped"},
			],
		};
	}
	context[epicTaskId(epic)] = taskContext(machinery);
	states[EPIC_PHASE] = {
		type: "parallel",
		states: {[epicTaskId(epic)]: epicRegion(epicTaskId(epic).toUpperCase(), machinery)},
		onDone: [{target: "complete", guard: "noErrors"}, {target: "tripped"}],
	};
	states.complete = {type: "final"};
	states.tripped = {type: "final"};

	const first = order[0];
	const doc = {
		id: `epic-${epic}`,
		version: 1,
		machine: {
			id: `epic-${epic}`,
			initial: phaseName(first ?? 1),
			context,
			states,
		},
	};
	return {
		_tag: "Emitted",
		text: `${JSON.stringify(doc, null, "\t")}\n`,
		phases: order.length,
		children: declared.lines.length,
		dropped: declared.dropped,
	};
};
