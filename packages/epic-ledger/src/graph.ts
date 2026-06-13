/**
 * Dependency-graph cycle detection over a `DependencyGraph`'s edges.
 *
 * An edge `{child, requires}` means `child` waits on `requires`; a cycle is a
 * set of issues that transitively wait on each other, which would deadlock the
 * pick loop (no member can ever become eligible). Detection is deterministic:
 * nodes are visited in ascending numeric order and each returned cycle is
 * rotated to start at its smallest member and reported as a sorted set, so the
 * same graph always yields the same cycle list regardless of edge insertion
 * order. Reporting cycles as sorted *sets* (not paths) keeps a finding's
 * identity stable.
 */
import type {DependencyEdge} from "./Ledger.ts";

/**
 * Find every distinct dependency cycle, each as an ascending-sorted set of the
 * issues participating in it. Two cycles sharing all members collapse to one;
 * the result list is sorted by smallest member. A graph with no cycle returns
 * `[]`.
 */
export const findCycles = (
	edges: ReadonlyArray<DependencyEdge>,
): ReadonlyArray<ReadonlyArray<number>> => {
	const adjacency = new Map<number, number[]>();
	const allNodes = new Set<number>();
	for (const {child, requires} of edges) {
		allNodes.add(child);
		allNodes.add(requires);
		const list = adjacency.get(child);
		if (list) list.push(requires);
		else adjacency.set(child, [requires]);
	}
	for (const list of adjacency.values()) list.sort((a, b) => a - b);

	const nodes = [...allNodes].sort((a, b) => a - b);
	const WHITE = 0;
	const GREY = 1;
	const BLACK = 2;
	const color = new Map<number, number>(nodes.map((n) => [n, WHITE]));
	const stack: number[] = [];
	const onStack = new Set<number>();
	const seen = new Set<string>();
	const cycles: number[][] = [];

	const recordCycle = (members: ReadonlyArray<number>) => {
		const sorted = [...new Set(members)].sort((a, b) => a - b);
		const key = sorted.join(",");
		if (seen.has(key)) return;
		seen.add(key);
		cycles.push(sorted);
	};

	const visit = (node: number) => {
		color.set(node, GREY);
		stack.push(node);
		onStack.add(node);
		for (const next of adjacency.get(node) ?? []) {
			if (color.get(next) === GREY && onStack.has(next)) {
				const from = stack.indexOf(next);
				recordCycle(stack.slice(from));
			} else if (color.get(next) === WHITE) {
				visit(next);
			}
		}
		color.set(node, BLACK);
		stack.pop();
		onStack.delete(node);
	};

	for (const node of nodes) {
		if (color.get(node) === WHITE) visit(node);
	}

	return cycles.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
};
