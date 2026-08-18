/**
 * The pure epic-machine emitter — one epic body plus its child links in, one `workflow.json` text
 * out, byte-deterministic (#5688; phase 3 of #5680).
 *
 * **No second grammar and no second cycle walk.** The topology is read through the shipped
 * `build/dependencies.ts` parser — the same reader `build eligible` gates on — and the cycle check
 * is `ledger/topology-doc.ts`'s `findCycle` over the same union graph (declared `requires` edges
 * plus the edges the phase order implies). What this module adds is only the machine rendering:
 * one region per child, phases sequenced by `onDone`, parallel within a phase, and one epic tail
 * phase after the last of them.
 *
 * **One epic run is one branch and one PR** (ADR 0285). A child's region is the local loop only —
 * `queued → build → review → integrate`, the integrate step merging the child's range into the epic
 * branch — and the merge to `main` lives once, in the tail phase's single epic-level region
 * (`review → ship → shipped`). The tail is a *phase* rather than a bare state because `machine.ts`
 * reads the workflow's two terminals off the last phase's `onDone` pair; shaped this way the
 * compiler needs no change at all.
 *
 * Determinism is by construction: phases ascend, children within a phase ascend, every object's
 * keys are inserted in one fixed order, and the serialization is a single `JSON.stringify` — the
 * same body bytes and the same child links (each child's number, state and close reason) can only
 * produce the same machine bytes. A child's state is part of the input: a closed child boots its
 * region in a final state, so re-emitting a partly-built epic yields a machine that can still
 * terminate (#5746).
 */
import {type Ref, readTopology} from "../build/dependencies.ts";
import {type DeclaredLine, findCycle} from "../ledger/topology-doc.ts";
import type {SubIssueLink} from "../plan/github.ts";
import {RETRY_BUDGET} from "../retry-budget.ts";

export type EmitResult =
	| {
			readonly _tag: "Emitted";
			readonly text: string;
			/** The child phases the topology declares. The machine also carries the epic tail phase. */
			readonly phases: number;
			readonly children: number;
	  }
	| {readonly _tag: "NoTopology"}
	| {readonly _tag: "Unparseable"; readonly line: number; readonly text: string}
	| {readonly _tag: "Foreign"; readonly ref: string}
	| {readonly _tag: "Duplicate"; readonly child: number}
	| {readonly _tag: "Unplaced"; readonly child: number}
	| {readonly _tag: "Cycle"; readonly path: ReadonlyArray<number>};

/**
 * Where a child's region boots. Only a `completed` close asserts the work landed, so only it earns
 * `landed`; every other close (`not_planned`, `duplicate`, a legacy null reason) is
 * closed-without-landing and boots `frozen` — `lane status` reads `frozen` as an error final and
 * trips the phase, which is the loud answer for a topology that still requires a child the board
 * abandoned. Marking it `landed` would fabricate a landing.
 */
const initialFor = (link: SubIssueLink): "queued" | "landed" | "frozen" => {
	if (link.state === "open") return "queued";
	return link.stateReason === "completed" ? "landed" : "frozen";
};

/**
 * One child's region — the local loop, namespaced to the child's task id.
 *
 * It ends at `landed`: the child's commits are on the epic's shared branch and nothing was pushed,
 * reviewed on GitHub or merged. There is no per-child `ship` and no per-child `human:cp-approval`
 * because there is no per-child PR to ship or to gate (ADR 0285).
 *
 * `integrate` is the merge of the reviewed range into the epic branch, and it is a *state* so that a
 * collision between two children resolves inside the run: its `FAIL` — a textual conflict, or a
 * failed post-merge check, which is the semantic collision — re-enters `build` under the same
 * guarded-FAIL retry array `review` uses, and exhausts into `frozen`. No route from it reaches a
 * merge queue, and none reaches `landed` without passing back through `review`: post-resolution
 * content is not what the range verdict judged, so the verdict is re-proven before the landing
 * rather than after it.
 */
const region = (ns: string, initial: "queued" | "landed" | "frozen"): Record<string, unknown> => ({
	initial,
	states: {
		queued: {on: {[`${ns}.WIP`]: "build", [`${ns}.BLOCKED`]: "blocked"}},
		build: {on: {[`${ns}.DONE`]: "review", [`${ns}.BLOCKED`]: "blocked"}},
		review: {
			on: {
				[`${ns}.PASS`]: "integrate",
				[`${ns}.BLOCKED`]: "blocked",
				[`${ns}.FAIL`]: [
					{target: "build", guard: "retriesRemaining", actions: "incrementRetries"},
					{target: "frozen"},
				],
			},
		},
		integrate: {
			on: {
				[`${ns}.DONE`]: "landed",
				[`${ns}.BLOCKED`]: "blocked",
				[`${ns}.FAIL`]: [
					{target: "build", guard: "retriesRemaining", actions: "incrementRetries"},
					{target: "frozen"},
				],
			},
		},
		blocked: {on: {[`${ns}.UNBLOCKED`]: "hist"}},
		hist: {type: "history"},
		landed: {type: "final"},
		frozen: {type: "final"},
	},
});

/**
 * The epic's own region — the tail phase's single task: review the one PR, then merge it once.
 *
 * `ship` carries the same guarded FAIL, because a PR can be re-reviewed at a rewritten head while
 * the lane sits there and a park clear is exactly that path (#5807). Its retry arm is `review` for
 * the same reason the review edge's is: the repair round happens outside the machine, so the next
 * thing the lane can record is another verdict.
 *
 * `review` FAIL is a two-arm guarded array so the fallthrough final is an *error* final by the
 * compiler's own structural read; a plain target would leave a failed epic review folding to
 * `complete`. The retry arm is `review` itself: a repair round happens outside the machine and the
 * next verdict is another review. Where the fallthrough goes — `human:epic-review`, a park-shaped
 * final that trips the lane for a human — is deliberately the safe placeholder #5793 asked for, not
 * a resolved answer: what a failing epic review *means* is still an open founder question.
 */
const epicRegion = (ns: string): Record<string, unknown> => ({
	initial: "review",
	states: {
		review: {
			on: {
				[`${ns}.PASS`]: "ship",
				[`${ns}.BLOCKED`]: "blocked",
				[`${ns}.FAIL`]: [
					{target: "review", guard: "retriesRemaining", actions: "incrementRetries"},
					{target: "human:epic-review"},
				],
			},
		},
		ship: {
			on: {
				[`${ns}.DONE`]: "shipped",
				[`${ns}.BLOCKED`]: "human:cp-approval",
				[`${ns}.FAIL`]: [
					{target: "review", guard: "retriesRemaining", actions: "incrementRetries"},
					{target: "human:epic-review"},
				],
			},
		},
		blocked: {on: {[`${ns}.UNBLOCKED`]: "hist"}},
		"human:cp-approval": {on: {[`${ns}.UNBLOCKED`]: "hist"}},
		hist: {type: "history"},
		shipped: {type: "final"},
		"human:epic-review": {type: "final"},
	},
});

const taskId = (child: number): string => `issue_${child}`;

/** The tail phase's name and its one task id. Neither can collide with a `phase<N>`/`issue_<n>`. */
const EPIC_PHASE = "epic";
const epicTaskId = (epic: number): string => `epic_${epic}`;

const ascending = (values: Iterable<number>): ReadonlyArray<number> =>
	[...values].sort((a, b) => a - b);

/** Emit the epic's lane machine from its body's `## Dependencies` block and its child links. */
export const emitMachine = (
	epic: number,
	body: string,
	children: ReadonlyArray<SubIssueLink>,
): EmitResult => {
	// Childlessness is read before the body, because an issue with no sub-issue links is not an epic
	// whatever its prose says — parsing first let a plain issue's `## Dependencies` heading refuse as
	// a malformed epic record and dead-end the boot (#5973).
	if (children.length === 0) return {_tag: "NoTopology"};

	const topo = readTopology(body);
	if (topo._tag === "Absent") return {_tag: "NoTopology"};
	if (topo._tag === "Unparseable") return {_tag: "Unparseable", line: topo.line, text: topo.text};

	const initials = new Map(children.map((link) => [link.number, initialFor(link)]));
	const known = new Set(initials.keys());
	// Every phase member is checked against `known` below, so the lookup holds by construction; the
	// throw is the invariant's enforcement site — a defaulted initial would re-open #5746.
	const initialOf = (child: number): "queued" | "landed" | "frozen" => {
		const initial = initials.get(child);
		if (initial === undefined) throw new Error(`no child link for #${child}`);
		return initial;
	};
	const issueNumbers = (refs: ReadonlyArray<Ref>): number[] =>
		refs.flatMap((ref) => (ref._tag === "Issue" ? [ref.number] : []));
	const phases = new Map<number, number[]>();
	const requires = new Map<number, number[]>();
	for (const edge of topo.edges) {
		const refs = edge._tag === "Phase" ? edge.members : [edge.subject, ...edge.needs];
		for (const ref of refs) {
			if (ref._tag === "Local") return {_tag: "Foreign", ref: ref.id};
			if (!known.has(ref.number)) return {_tag: "Foreign", ref: `#${ref.number}`};
		}
		if (edge._tag === "Phase") {
			const members = issueNumbers(edge.members);
			phases.set(edge.phase, [...(phases.get(edge.phase) ?? []), ...members]);
			continue;
		}
		const [subject] = issueNumbers([edge.subject]);
		if (subject === undefined) continue;
		requires.set(subject, [...(requires.get(subject) ?? []), ...issueNumbers(edge.needs)]);
	}
	if (phases.size === 0) return {_tag: "NoTopology"};

	const placed = new Map<number, number>();
	for (const [phase, members] of phases) {
		for (const child of members) {
			if (placed.has(child)) return {_tag: "Duplicate", child};
			placed.set(child, phase);
		}
	}
	for (const [subject, needs] of requires) {
		for (const child of [subject, ...needs]) {
			if (!placed.has(child)) return {_tag: "Unplaced", child};
		}
	}

	const lines: DeclaredLine[] = [...placed.entries()].map(([child, phase]) => ({
		child,
		phase,
		requires: requires.get(child) ?? [],
	}));
	const cycle = findCycle(lines);
	if (cycle !== null) return {_tag: "Cycle", path: cycle};

	const order = ascending(phases.keys());
	const phaseName = (phase: number): string => `phase${phase}`;
	const context: Record<string, unknown> = {};
	const states: Record<string, unknown> = {};
	for (const [index, phase] of order.entries()) {
		const members = ascending(phases.get(phase) ?? []);
		for (const child of members) context[taskId(child)] = {retries: 0, maxRetries: RETRY_BUDGET};
		const next = order[index + 1];
		states[phaseName(phase)] = {
			type: "parallel",
			states: Object.fromEntries(
				members.map((child) => [
					taskId(child),
					region(taskId(child).toUpperCase(), initialOf(child)),
				]),
			),
			onDone: [
				{target: next === undefined ? EPIC_PHASE : phaseName(next), guard: "noErrors"},
				{target: "tripped"},
			],
		};
	}
	context[epicTaskId(epic)] = {retries: 0, maxRetries: RETRY_BUDGET};
	states[EPIC_PHASE] = {
		type: "parallel",
		states: {[epicTaskId(epic)]: epicRegion(epicTaskId(epic).toUpperCase())},
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
		children: placed.size,
	};
};
