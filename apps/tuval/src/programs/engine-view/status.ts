/**
 * `engine-view`'s status renderer: what this program puts in the middle of the desk's status bar
 * while one of its windows is focused (#7500 ruling 5).
 *
 * Three segments and no more — the process count, the edge count and the selection — because the
 * left and the right are the shell's and a program has no vocabulary to ask for either
 * (`src/shell/desk/renderer.ts`). The edge count is the projection's own
 * (`./projection.ts`), not `processes.length - roots`: an edge is emitted only where a parent
 * resolves to a present row, so the bar states the number of edges the canvas actually drew.
 *
 * **Why the renderer is minted from facts rather than reading them off its host.** `segments` is
 * synchronous and a `WindowHost` carries one process, asynchronously (`readProcess` is a stream), so
 * neither the table nor this program's committed selection can be read there. The shell assembles
 * the `statuses` table for each `DeskSnapshot` it composes, so the facts are bound at that point —
 * which leaves this a pure function of the Snapshot plus the program's own state, which is what the
 * issue asks for, and leaves nothing here to fetch.
 */

import type {ProcessRow} from "../../protocol/process-row.ts";
import type {StatusRenderer, StatusSegment} from "../../shell/desk/renderer.ts";
import {statusRenderer} from "../../shell/desk/renderer.ts";
import type {ViewState} from "../../shell/window/host.ts";
import {processCountSegment, selectedSegments} from "../desk-renderers/segments.ts";
import type {EngineViewMsg, EngineViewState} from "./program.ts";
import {projectProcessGraph} from "./projection.ts";
import {tableRowsFromSnapshot} from "./snapshot-rows.ts";

/** What the segments are derived from: the Snapshot's rows, and this program's committed state. */
export interface EngineViewStatusFacts {
	readonly processes: ReadonlyArray<ProcessRow>;
	readonly state: EngineViewState;
}

export const engineViewStatusSegments = (
	facts: EngineViewStatusFacts,
): ReadonlyArray<StatusSegment> => {
	const graph = projectProcessGraph(tableRowsFromSnapshot(facts.processes));
	return [
		processCountSegment(graph.nodes.length),
		{id: "edges", text: `${graph.edges.length} edge${graph.edges.length === 1 ? "" : "s"}`},
		...selectedSegments(facts.state.selected),
	];
};

export const engineViewStatusRenderer = (
	facts: EngineViewStatusFacts,
): StatusRenderer<EngineViewState, EngineViewMsg, ViewState> =>
	statusRenderer<EngineViewState, EngineViewMsg, ViewState>("host-native", () =>
		engineViewStatusSegments(facts),
	);
