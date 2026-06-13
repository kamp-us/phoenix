/**
 * Test fixtures — small builders for the domain shapes, so each test states only
 * what it varies. Plain TS, no Effect (per `.patterns/effect-testing.md` §Helpers).
 */
import type {ChildIssue, DependencyGraph, EpicHeader, EpicLedger} from "./Ledger.ts";

export const child = (number: number, overrides: Partial<ChildIssue> = {}): ChildIssue => ({
	number,
	title: `child #${number}`,
	labels: ["type:feature", "p1", "status:triaged"],
	acceptanceCriteriaCount: 1,
	...overrides,
});

export const graph = (overrides: Partial<DependencyGraph> = {}): DependencyGraph => ({
	present: true,
	nodes: [],
	edges: [],
	...overrides,
});

export const epic = (overrides: Partial<EpicHeader> = {}): EpicHeader => ({
	number: 100,
	title: "epic #100",
	labels: ["type:epic", "p1", "status:triaged"],
	dependencies: graph(),
	...overrides,
});

export const ledger = (overrides: Partial<EpicLedger> = {}): EpicLedger => ({
	epic: epic(),
	children: [],
	...overrides,
});

/**
 * A structurally clean two-child ledger: both children referenced in the graph,
 * each with an AC and a full label set, no cycle, no dangling edge.
 */
export const cleanLedger = (): EpicLedger =>
	ledger({
		epic: epic({
			dependencies: graph({
				nodes: [101, 102],
				edges: [{child: 102, requires: 101}],
			}),
		}),
		children: [child(101), child(102)],
	});
