/**
 * The ledger `plan read` prints and the other three verbs re-derive — one shape, so the floor, the
 * digest and the flip all read the same document.
 *
 * Two fields exist only to keep an unread fact from reading as a permissive one, and neither is
 * collapsible into the value beside it:
 *
 * - `assigneesObserved` splits *the payload carried no `assignees` key* from *the key was there and
 *   held nothing*. `UNVERIFIABLE_ASSIGNEE` rests on exactly that split.
 * - `criteria` carries the imported wire read's own token rather than a count alone, so an `absent`
 *   block and a `malformed` one stay distinguishable after the read.
 */

/** The acceptance-criteria read's arm, carried through and never flattened. */
export type CriteriaToken = "found" | "absent" | "malformed";

export interface ChildLedger {
	readonly number: number;
	readonly labels: ReadonlyArray<string>;
	/** The observed logins, or `null` when the payload carried no `assignees` key at all. */
	readonly assignees: ReadonlyArray<string> | null;
	readonly assigneesObserved: boolean;
	readonly criteria: CriteriaToken;
	readonly criteriaCount: number;
	/** The claimed story ids, or `null` when the line is absent or its value does not conform. */
	readonly stories: ReadonlyArray<number> | null;
	/** The non-conforming value, quoted by `MISSING_STORY`'s detail; `null` when there was none. */
	readonly storiesValue: string | null;
	/** The declared containment keyword, off the resolved vocabulary; `null` when there is none. */
	readonly containment: string | null;
}

/** The cycle-doc probe, three-valued: only `unknown` puts `MISSING_CONTAINMENT` in `skipped`. */
export type CycleDoc = "present" | "absent" | "unknown";

/** One phase line, by its declared number — the digest serializes the number, not the position. */
export interface Phase {
	readonly phase: number;
	readonly members: ReadonlyArray<string>;
}

/** An edge is ordered `[dependent, prerequisite]`: `["#b","#a"]` reads *child b requires child a*. */
export type DependencyEdge = readonly [string, string];

export interface PlanTopology {
	readonly phases: ReadonlyArray<Phase>;
	readonly edges: ReadonlyArray<DependencyEdge>;
}

export interface Ledger {
	readonly epic: number;
	readonly children: ReadonlyArray<ChildLedger>;
	readonly epicStories: ReadonlyArray<number>;
	/**
	 * The epic's own acceptance criteria, in body order — the contract its tail PR is graded against.
	 *
	 * Empty when the body carries no readable block, which is every epic planned before the criteria
	 * section joined the plan and nothing planned since: `ledger draft` refuses a plan whose criteria
	 * do not read back `Found`,
	 * so `absent` and `malformed` cannot be told apart here and nothing needs to.
	 */
	readonly epicCriteria: ReadonlyArray<string>;
	readonly cycleDoc: CycleDoc;
	readonly topology: PlanTopology;
	/** The epic body carries no `## Dependencies` heading — `MISSING_DEPS_SECTION`'s only input. */
	readonly dependenciesAbsent: boolean;
	readonly digest: string;
}

/** The `topology` value as `plan read` prints it: members per phase, ascending, then the edges. */
export const renderTopology = (
	topology: PlanTopology,
): {
	readonly phases: ReadonlyArray<ReadonlyArray<string>>;
	readonly edges: ReadonlyArray<DependencyEdge>;
} => ({
	phases: [...topology.phases].sort((a, b) => a.phase - b.phase).map((phase) => [...phase.members]),
	edges: topology.edges,
});
