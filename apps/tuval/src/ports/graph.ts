/**
 * The authoring shape of a graph: nodes that own their outbound routes as `on` entries (#7370,
 * spike #7379). There is no top-level edge list; `compile` normalizes routes internally and that
 * normalized form is `CompiledGraph`, never something an author writes.
 */

import {Schema} from "effect";
import type {InPort, ProgramId} from "../registry/program.ts";

export const NodeId = Schema.String.pipe(Schema.brand("tuval/NodeId"));
export type NodeId = typeof NodeId.Type;

export interface PortRef {
	readonly node: NodeId;
	readonly port: string;
}

/** One outbound route: this node's out-port `port` feeds `to`. */
export interface OutboundRoute {
	readonly port: string;
	readonly to: PortRef;
}

/** A planned process: which program runs here, and where its output goes. */
export interface GraphNode {
	readonly id: NodeId;
	readonly program: ProgramId;
	readonly on: ReadonlyArray<OutboundRoute>;
}

export interface Graph {
	readonly nodes: ReadonlyArray<GraphNode>;
}

export interface CompiledNode {
	readonly id: NodeId;
	readonly program: ProgramId;
	readonly inPorts: Readonly<Record<string, InPort>>;
}

/** A route proven compatible: both ends resolved to declared ports of one kind. */
export interface CompiledRoute {
	readonly kind: string;
	readonly source: PortRef & {readonly program: ProgramId};
	readonly target: PortRef & {readonly program: ProgramId};
}

export interface CompiledGraph {
	readonly nodes: ReadonlyArray<CompiledNode>;
	/** In authoring order: node order, then each node's `on` order. Delivery follows this order. */
	readonly routes: ReadonlyArray<CompiledRoute>;
}
