/**
 * The two demo programs and the graph that wires them: `counter.ticks -> log.ticks`, with the
 * log a child of the counter. `tuval.config.ts` registers exactly this; the end-to-end proof
 * boots the same rows with a probe for `write` and no timer.
 */

import type {Effect} from "effect";
import {type Graph, NodeId} from "../ports/graph.ts";
import type {AnyProgram} from "../registry/program.ts";
import {counterId, counterProgram} from "./counter.ts";
import {logId, logProgram} from "./log.ts";

export interface DemoOptions {
	readonly everyMs: number | null;
	readonly write: (line: string) => Effect.Effect<void>;
}

export const counterNode = NodeId.make("counter");
export const logNode = NodeId.make("log");

export const demoGraph: Graph = {
	nodes: [
		{
			id: counterNode,
			program: counterId,
			on: [{port: "ticks", to: {node: logNode, port: "ticks"}}],
		},
		{id: logNode, program: logId, parent: counterNode, on: []},
	],
};

export const demoPrograms = (options: DemoOptions): ReadonlyArray<AnyProgram> => [
	counterProgram({everyMs: options.everyMs}),
	logProgram({write: options.write}),
];
