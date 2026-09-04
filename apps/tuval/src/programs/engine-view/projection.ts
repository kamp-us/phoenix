/**
 * The process table as a graph: one generic node per row, one edge per resolvable parent.
 *
 * Generic means generic. A node carries the process id, the program id, the port declarations and
 * the lifecycle/revision summary, and nothing else — no per-program node data, no session domain,
 * and no rendering library's type (`boundary.unit.test.ts` proves both halves of that).
 *
 * The frozen #7190 POC reconciled its lineage in
 * `packages/tuval/src/frontend-shell/canvas-adapter.ts` on `epic/7140`. Three shapes it got right
 * are hand-ported here: node identity is the domain id, so a re-render keeps selection and
 * position; an edge exists only where both of its ends resolve to present nodes; and a row that has
 * left the table takes its edges with it rather than leaving a dangling one. Its `SessionNodeData`
 * / `LineageEdge` domain does not survive the port — the node here is a process, not a Pi session —
 * and its `nodeDepths` placement is replaced by dagre in `layout.ts`.
 */

import {Option} from "effect";
import type {ProcessId, ProgramId} from "../../protocol/ids.ts";
import type {PortDeclaration, TableRow, TableStateSummary} from "../../table/row.ts";

/** One process, drawn. The id is the process id, so it is stable across every call. */
export interface EngineNode {
	readonly id: ProcessId;
	readonly programId: ProgramId;
	readonly ports: Readonly<Record<string, PortDeclaration>>;
	readonly stateSummary: TableStateSummary;
}

/** A parent-to-child edge. `target` names the child, and a child has at most one parent. */
export interface EngineEdge {
	readonly id: string;
	readonly source: ProcessId;
	readonly target: ProcessId;
}

export interface EngineGraph {
	readonly nodes: ReadonlyArray<EngineNode>;
	readonly edges: ReadonlyArray<EngineEdge>;
}

/**
 * A child has one parent, so the child's id already identifies the edge; a composed `parent->child`
 * id would be ambiguous the moment a process id contains the separator.
 */
export const engineEdgeId = (child: ProcessId): string => `edge:${child}`;

const toEngineNode = (row: TableRow): EngineNode => ({
	id: row.id,
	programId: row.programId,
	ports: row.ports,
	stateSummary: row.stateSummary,
});

/** Whether `from` already carries `target` among its ancestors in the forest built so far. */
const reaches = (parentOf: ReadonlyMap<string, string>, from: string, target: string): boolean => {
	const seen = new Set<string>();
	let current: string | undefined = from;
	while (current !== undefined && !seen.has(current)) {
		if (current === target) return true;
		seen.add(current);
		current = parentOf.get(current);
	}
	return false;
};

/**
 * Rows to nodes and edges, pure and total over any row list.
 *
 * Node order is the input's, so the caller keeps whatever order the snapshot arrived in. An edge is
 * emitted only where the row's `parentId` is a `Some`, names a row present in the same input, and
 * does not close a cycle in the forest built so far. That last guard is the one place the result is
 * narrower than "an edge per resolvable parent": a real process table cannot cycle, because a
 * parent is stamped at spawn and a spawn precedes its child's existence, but this function is total
 * over rows it did not produce, and a cycle has no top-down layout — dagre would have to break it
 * arbitrarily. Breaking it here keeps the domain a forest and keeps the rule stated. A row naming
 * itself is the length-one case of that same cycle and needs no rule of its own.
 */
export const projectProcessGraph = (rows: ReadonlyArray<TableRow>): EngineGraph => {
	const nodes = rows.map(toEngineNode);
	const present = new Set<string>(nodes.map((node) => node.id));
	const parentOf = new Map<string, string>();
	const edges: Array<EngineEdge> = [];
	for (const row of rows) {
		if (Option.isNone(row.parentId)) continue;
		const parent = row.parentId.value;
		if (!present.has(parent)) continue;
		// Two rows sharing an id are not a table this can happen to, but the first one wins rather
		// than the graph growing a second parent for one child.
		if (parentOf.has(row.id)) continue;
		if (reaches(parentOf, parent, row.id)) continue;
		parentOf.set(row.id, parent);
		edges.push({id: engineEdgeId(row.id), source: parent, target: row.id});
	}
	return {nodes, edges};
};
