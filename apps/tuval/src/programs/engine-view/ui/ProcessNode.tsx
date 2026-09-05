/**
 * The one node component. There is exactly one for every process, whatever program it runs — a
 * per-program node renderer is a non-goal of this epic, and the row it draws is program-blind
 * (`src/table/row.ts`) precisely so this component can stay one.
 *
 * The two `Handle`s are structural, not interactive: React Flow resolves an edge's ends against a
 * node's handles, so a node with none renders no edges at all. Both are `isConnectable={false}`,
 * which is the per-node half of the read-only configuration the canvas sets flow-wide.
 */

import {type Node as FlowNode, Handle, type NodeProps, Position} from "@xyflow/react";
import type {ReactNode} from "react";

export type ProcessPortLine = {
	readonly name: string;
	readonly kind: string;
	readonly direction: "in" | "out";
};

/**
 * A type alias rather than an interface: `@xyflow/react`'s `Node` constrains its data to
 * `Record<string, unknown>`, and only an alias of an object type carries the implicit index
 * signature that satisfies it.
 */
export type ProcessNodeData = {
	readonly programId: string;
	readonly lifecycle: string;
	readonly revision: number;
	readonly ports: ReadonlyArray<ProcessPortLine>;
	/** Read off the program's own state every render — never React Flow's internal selection. */
	readonly selected: boolean;
};

export const PROCESS_NODE_TYPE = "process";

export type ProcessFlowNode = FlowNode<ProcessNodeData, typeof PROCESS_NODE_TYPE>;

/** The arrow a port line shows for its direction, so direction never rides on position alone. */
const arrow = (direction: "in" | "out"): string => (direction === "in" ? "→" : "←");

export function ProcessNode({id, data}: NodeProps<ProcessFlowNode>): ReactNode {
	return (
		<div className="engine-node" data-selected={data.selected}>
			<Handle type="target" position={Position.Top} isConnectable={false} />
			<p className="engine-node-id">{id}</p>
			<p className="engine-node-program">{data.programId}</p>
			<p className="engine-node-state">
				{/* The lifecycle word itself, not a coloured dot: pillar 4 forbids state on colour alone. */}
				<span className="engine-node-lifecycle">{data.lifecycle}</span>
				<span className="engine-node-revision">r{data.revision}</span>
			</p>
			{data.ports.length > 0 && (
				<ul className="engine-node-ports">
					{data.ports.map((port) => (
						<li key={port.name}>
							<span className="engine-node-port-arrow">{arrow(port.direction)}</span> {port.name}{" "}
							<span className="engine-node-port-kind">{port.kind}</span>
						</li>
					))}
				</ul>
			)}
			<Handle type="source" position={Position.Bottom} isConnectable={false} />
		</div>
	);
}
