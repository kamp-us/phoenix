/**
 * The engine view's window: the process table as a read-only React Flow canvas.
 *
 * **Read-only is a configuration, not a promise.** Every prop that could let a gesture change the
 * graph is off — `nodesDraggable`, `nodesConnectable`, `elementsSelectable`, `edgesReconnectable`,
 * `edgesFocusable`, `connectOnClick` — and `onConnect`, `onNodesChange` and `onEdgesChange` are not
 * passed at all, so React Flow has nowhere to report a change to and nothing here holds a mutable
 * copy to apply one to. The graph is re-derived from the desk `Snapshot` on every render
 * (`projectProcessGraph` then `layoutEngineGraph`), so there is no local graph state that could
 * drift from the table even if something did try.
 *
 * **Selection lives in the program, not in the library.** `elementsSelectable` being off means
 * React Flow's own `selected` flag never moves; the selected process id is a value the program's
 * machine commits (`../program.ts`), read back here through the window contract. That is what lets
 * the desk inspector show the selection without reaching inside this window (founder ruling 4).
 *
 * **Keyboard reachability is React Flow's own.** `nodesFocusable` and `disableKeyboardA11y` are
 * left at their defaults, so every node is a `tabIndex={0}` element with an `aria-label` React Flow
 * puts there itself. Founder ruling 7 rules out a bespoke canvas accessibility contract in this
 * slice — no roving tabindex, no ARIA tree, no live region — and the `ps` program is the
 * screen-reader-friendly twin.
 */

import {
	Background,
	BackgroundVariant,
	Controls,
	type Edge,
	MiniMap,
	ReactFlow,
	ReactFlowProvider,
} from "@xyflow/react";
import {Effect} from "effect";
import type {FocusEvent, KeyboardEvent, ReactNode} from "react";
import {useCallback, useEffect, useMemo} from "react";
import type {ProcessId} from "../../../protocol/ids.ts";
import {commandPath} from "../../../shell/commands/row.ts";
import {ATTACH_COMMAND} from "../../../shell/picker/intent.ts";
import type {ViewState, WindowHost} from "../../../shell/window/host.ts";
import {layoutEngineGraph} from "../layout.ts";
import type {EngineViewMsg, EngineViewState} from "../program.ts";
import {projectProcessGraph} from "../projection.ts";
import {tableRowsFromSnapshot} from "../snapshot-rows.ts";
import {useDeskAccess} from "./desk.tsx";
import {
	PROCESS_NODE_TYPE,
	type ProcessFlowNode,
	ProcessNode,
	type ProcessPortLine,
} from "./ProcessNode.tsx";
import {useProcessState} from "./process-state.ts";
import "@xyflow/react/dist/style.css";
import "./engine-view.css";

/** The shell's own attach path, read off its command row so the two cannot drift (#7557). */
export const ATTACH_SPELL_PATH = commandPath(ATTACH_COMMAND);

const nodeTypes = {[PROCESS_NODE_TYPE]: ProcessNode};

/**
 * React Flow stamps every node wrapper with `data-id` (`@xyflow/react` 12.11.6, `NodeWrapper`), and
 * that attribute is the whole route from a bubbled DOM event back to a node — the library exposes
 * no focus callback, and its per-node `domAttributes` escape hatch excludes every DOM handler.
 */
const nodeIdOf = (target: EventTarget | null): ProcessId | null => {
	if (!(target instanceof Element)) return null;
	const id = target.closest(".react-flow__node")?.getAttribute("data-id");
	return id === null || id === undefined ? null : (id as ProcessId);
};

const portLines = (
	ports: Readonly<Record<string, {readonly kind: string; readonly direction: "in" | "out"}>>,
): ReadonlyArray<ProcessPortLine> =>
	Object.entries(ports)
		.map(([name, port]) => ({name, kind: port.kind, direction: port.direction}))
		.sort((left, right) => (left.name < right.name ? -1 : 1));

export interface EngineViewCanvasProps {
	readonly host: WindowHost<EngineViewState, EngineViewMsg, ViewState>;
}

function Canvas({host}: EngineViewCanvasProps): ReactNode {
	const {processes, callSpell} = useDeskAccess();
	const state = useProcessState<EngineViewState>(host);
	const selected = state?.selected ?? null;

	const graph = useMemo(
		() => layoutEngineGraph(projectProcessGraph(tableRowsFromSnapshot(processes))),
		[processes],
	);

	const send = useCallback((msg: EngineViewMsg) => void Effect.runFork(host.dispatch(msg)), [host]);

	// A selection whose process has left the table is cleared in the program, not hidden here: the
	// inspector reads that field and would otherwise be pointed at a process nobody can attach to.
	useEffect(() => {
		if (selected === null) return;
		const present = graph.nodes.map((node) => node.id);
		if (present.includes(selected)) return;
		send({type: "tableChanged", present});
	}, [selected, graph, send]);

	const nodes = useMemo<ReadonlyArray<ProcessFlowNode>>(
		() =>
			graph.nodes.map((node) => ({
				id: node.id,
				type: PROCESS_NODE_TYPE,
				position: node.position,
				width: node.size.width,
				height: node.size.height,
				ariaLabel: `Process ${node.id}, program ${node.programId}, ${node.stateSummary.lifecycle}`,
				data: {
					programId: node.programId,
					lifecycle: node.stateSummary.lifecycle,
					revision: node.stateSummary.revision,
					ports: portLines(node.ports),
					selected: node.id === selected,
				},
			})),
		[graph, selected],
	);

	const edges = useMemo<ReadonlyArray<Edge>>(
		() => graph.edges.map((edge) => ({id: edge.id, source: edge.source, target: edge.target})),
		[graph],
	);

	// `onFocus` is React's `focusin`, so it fires here when a node wrapper takes focus by Tab or by
	// pointer. Focusing selects, which is what makes "Enter on the selected node" and "Enter on the
	// focused node" the same act for a keyboard user.
	const onFocus = useCallback(
		(event: FocusEvent<HTMLDivElement>) => {
			const processId = nodeIdOf(event.target);
			if (processId !== null) send({type: "select", processId});
		},
		[send],
	);

	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (event.key !== "Enter") return;
			const processId = nodeIdOf(event.target);
			if (processId === null) return;
			event.preventDefault();
			callSpell(ATTACH_SPELL_PATH, {process: processId});
		},
		[callSpell],
	);

	return (
		<div className="engine-view">
			{/* The handlers ride the flow's own wrapper — the one element here a user can focus into,
			    since every focusable node is inside it and both events bubble. */}
			<ReactFlow
				onFocus={onFocus}
				onKeyDown={onKeyDown}
				nodes={[...nodes]}
				edges={[...edges]}
				nodeTypes={nodeTypes}
				colorMode="dark"
				fitView
				nodesDraggable={false}
				nodesConnectable={false}
				elementsSelectable={false}
				edgesReconnectable={false}
				edgesFocusable={false}
				connectOnClick={false}
				deleteKeyCode={null}
				onNodeClick={(_event, node) => send({type: "select", processId: node.id as ProcessId})}
			>
				<Background variant={BackgroundVariant.Dots} gap={16} size={1} />
				<Controls showInteractive={false} />
				<MiniMap pannable zoomable />
			</ReactFlow>
		</div>
	);
}

/**
 * The provider is mounted here rather than by the shell because React Flow's store is per canvas
 * and a window is exactly one canvas.
 */
export function EngineViewCanvas({host}: EngineViewCanvasProps): ReactNode {
	return (
		<ReactFlowProvider>
			<Canvas host={host} />
		</ReactFlowProvider>
	);
}
