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
	stories: [1],
	// Conformant by default so a `type:feature` default child doesn't trip
	// MISSING_CONTAINMENT under the default `cycleDocPresent: true`; tests that want
	// a missing/`none` marker set `containment` (or override to `undefined`) explicitly.
	containment: "exempt",
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
	// Conformant by default (declares story 1, which the default `child` covers) so
	// unrelated fixtures don't trip MISSING_STORIES_SECTION; tests that want a
	// story-less epic set `stories: []` explicitly.
	stories: [1],
	...overrides,
});

export const ledger = (overrides: Partial<EpicLedger> = {}): EpicLedger => ({
	epic: epic(),
	children: [],
	externalRefs: [],
	// Default to a phoenix-like repo that HAS a cycle doc, so MISSING_CONTAINMENT is
	// in force by default; a foreign-install fixture sets `cycleDocPresent: false`.
	cycleDocPresent: true,
	...overrides,
});

/**
 * A structurally clean two-child ledger: both children referenced in the graph,
 * each with an AC and a full label set, no cycle, no dangling edge, and the
 * epic's one declared story (#1) covered by both children.
 */
export const cleanLedger = (): EpicLedger =>
	ledger({
		epic: epic({
			stories: [1],
			dependencies: graph({
				nodes: [101, 102],
				edges: [{child: 102, requires: 101}],
			}),
		}),
		children: [child(101), child(102)],
	});
