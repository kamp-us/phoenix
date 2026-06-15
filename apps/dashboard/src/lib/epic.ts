/**
 * The PURE pickable/blocked + phase-progress derivation for the epic detail view.
 * No React, no fetch — total functions over the structured pipeline state the
 * `/api/pipeline` route returns, so the load-bearing logic is unit-testable
 * against fixtures (ADR 0040, `.patterns/effect-testing.md`).
 *
 * Pickability mirrors `.claude/skills/gh-issue-intake-formats.md` §Dependencies:
 * a child is actionable only when `status:triaged` AND its dependencies are
 * closed. The dependency gate is `requires:`-precise when the child carries a
 * `requires:` edge, else the phase-boundary default (all earlier-phase issues
 * closed). Blockedness is derived here, never read from a label.
 */

/** The subset of an API issue this derivation needs: its number, state, parsed status. */
export interface ChildFacts {
	readonly number: number;
	readonly state: "open" | "closed";
	readonly status: string | null;
}

/** The subset of an API epic this derivation needs: children + the parsed topology. */
export interface EpicTopology {
	readonly children: ReadonlyArray<number>;
	readonly phases: ReadonlyArray<{readonly phase: number; readonly issues: ReadonlyArray<number>}>;
	readonly requires: ReadonlyArray<{readonly from: number; readonly to: number}>;
}

export type Pickability =
	| {readonly kind: "pickable"}
	| {readonly kind: "blocked"; readonly reason: string}
	| {readonly kind: "not-triaged"; readonly reason: string};

export interface ChildDerivation {
	readonly number: number;
	readonly pickability: Pickability;
}

/**
 * The phase a child sits in, by the topology's phase list. A child listed in no
 * phase (e.g. a sub-issue the planner didn't place on the spine) has `null` phase
 * and is gated only by its explicit `requires:` edges.
 */
const phaseOf = (topology: EpicTopology, child: number): number | null => {
	for (const p of topology.phases) {
		if (p.issues.includes(child)) return p.phase;
	}
	return null;
};

/** Every issue number listed in a phase strictly earlier than `phase`. */
const earlierPhaseIssues = (topology: EpicTopology, phase: number): ReadonlyArray<number> => {
	const out: number[] = [];
	for (const p of topology.phases) {
		if (p.phase < phase) out.push(...p.issues);
	}
	return out;
};

/** The `requires:` targets gating `child` (the `to` of every edge whose `from` is `child`). */
const requiresTargets = (topology: EpicTopology, child: number): ReadonlyArray<number> =>
	topology.requires.filter((e) => e.from === child).map((e) => e.to);

/**
 * Derive a single child's pickability from its status, the topology, and a lookup
 * of every known issue's state. An issue not in `stateOf` is treated as open (its
 * closure is unproven, so it cannot satisfy a gate) — fail-closed.
 *
 * Order of the verdict: not-triaged first (a child that hasn't cleared the plan
 * gate is unpickable regardless of deps), then the dependency closure. When a
 * `requires:` edge is present it is the precise gate; otherwise the phase boundary
 * (all earlier-phase issues closed) is the default — matching the formats §Dependencies
 * "honor `requires:` when present, fall back to the phase boundary when absent."
 */
export const deriveChild = (
	child: ChildFacts,
	topology: EpicTopology,
	stateOf: ReadonlyMap<number, "open" | "closed">,
): ChildDerivation => {
	if (child.status !== "triaged") {
		return {
			number: child.number,
			pickability: {
				kind: "not-triaged",
				reason: child.status ? `status:${child.status} (not yet triaged)` : "untriaged",
			},
		};
	}

	const isClosed = (n: number): boolean => stateOf.get(n) === "closed";

	const requires = requiresTargets(topology, child.number);
	if (requires.length > 0) {
		const open = requires.filter((n) => !isClosed(n));
		if (open.length > 0) {
			return {
				number: child.number,
				pickability: {
					kind: "blocked",
					reason: `requires ${open.map((n) => `#${n}`).join(", ")}`,
				},
			};
		}
		return {number: child.number, pickability: {kind: "pickable"}};
	}

	const phase = phaseOf(topology, child.number);
	if (phase !== null) {
		const predecessors = earlierPhaseIssues(topology, phase);
		const openPhases = new Set<number>();
		for (const p of topology.phases) {
			if (p.phase < phase && p.issues.some((n) => !isClosed(n))) openPhases.add(p.phase);
		}
		if (predecessors.some((n) => !isClosed(n))) {
			const waiting = [...openPhases].sort((a, b) => a - b);
			return {
				number: child.number,
				pickability: {
					kind: "blocked",
					reason:
						waiting.length === 1
							? `waiting on Phase ${waiting[0]}`
							: `waiting on Phases ${waiting.join(", ")}`,
				},
			};
		}
	}

	return {number: child.number, pickability: {kind: "pickable"}};
};

/** Derive every child's pickability in one pass. */
export const deriveChildren = (
	children: ReadonlyArray<ChildFacts>,
	topology: EpicTopology,
	stateOf: ReadonlyMap<number, "open" | "closed">,
): ReadonlyArray<ChildDerivation> => children.map((c) => deriveChild(c, topology, stateOf));

export interface PhaseProgress {
	/** The 1-based ordinal of the current (earliest not-fully-closed) phase, or null if all closed. */
	readonly currentPhase: number | null;
	/** How many phases the topology has. */
	readonly totalPhases: number;
	/** Children closed across the whole epic. */
	readonly closedChildren: number;
	/** Total children of the epic. */
	readonly totalChildren: number;
	/** A glanceable line, e.g. "Phase 2 of 4 · 3/5 children closed" or "All phases complete · 6/6 children closed". */
	readonly label: string;
}

/**
 * Derive epic-level phase progress: the current phase (earliest phase with an open
 * issue, since phases are the sequential spine), the phase count, and the
 * children-closed tally. "Current phase" is the first phase not fully closed; when
 * every phase is closed it is `null` and the label reads "All phases complete".
 *
 * Children count is over the epic's `children` set (the `sub_issues` relation),
 * not the phase membership — a child can be a sub-issue without sitting on the
 * dependency spine, and progress should still count it closed.
 */
export const derivePhaseProgress = (
	children: ReadonlyArray<ChildFacts>,
	topology: EpicTopology,
	stateOf: ReadonlyMap<number, "open" | "closed">,
): PhaseProgress => {
	const isClosed = (n: number): boolean => stateOf.get(n) === "closed";
	const totalChildren = children.length;
	const closedChildren = children.filter((c) => c.state === "closed").length;

	const ordered = [...topology.phases].sort((a, b) => a.phase - b.phase);
	const totalPhases = ordered.length;

	let currentPhase: number | null = null;
	for (const p of ordered) {
		if (p.issues.some((n) => !isClosed(n))) {
			currentPhase = p.phase;
			break;
		}
	}

	const childTally = `${closedChildren}/${totalChildren} children closed`;
	const label =
		totalPhases === 0
			? childTally
			: currentPhase === null
				? `All phases complete · ${childTally}`
				: `Phase ${currentPhase} of ${totalPhases} · ${childTally}`;

	return {currentPhase, totalPhases, closedChildren, totalChildren, label};
};
