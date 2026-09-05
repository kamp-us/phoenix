/**
 * `engine-view`'s inspector renderer: the selected node's detail, in the shell's one desk-level
 * inspector region (#7500 ruling 4 — "This is like Vim or even Figma", so no in-window side panel).
 *
 * This program's whole contribution is *which* process is selected. The facts and their drawing are
 * `../../desk-renderers/`'s, shared verbatim with `ps`, so the two inspectors cannot come to show
 * different things about one selection.
 *
 * The rows arrive as an argument rather than through `./desk.tsx`'s context, and the reason is the
 * region's level: that provider is mounted around this program's *window*, and the inspector is the
 * desk's. The shell assembles its `inspectors` table per `DeskSnapshot`, so binding the rows there
 * is the same read from the same one channel (founder ruling 2) reaching the one place a React
 * context cannot.
 */

import type {ReactNode} from "react";
import type {ProcessRow} from "../../../protocol/process-row.ts";
import type {InspectorRenderer} from "../../../shell/desk/renderer.ts";
import {inspectorRenderer} from "../../../shell/desk/renderer.ts";
import type {ViewState} from "../../../shell/window/host.ts";
import {processDetail} from "../../desk-renderers/detail.ts";
import {ProcessDetailView} from "../../desk-renderers/ProcessDetailView.tsx";
import {useSelectedProcessId} from "../../desk-renderers/selection.ts";
import {type EngineViewMsg, type EngineViewState, engineViewSelection} from "../program.ts";
import type {EngineViewHost} from "./renderer.tsx";

export interface EngineViewInspectorProps {
	/** `Snapshot.processes` — the only source of process facts this program reads. */
	readonly processes: ReadonlyArray<ProcessRow>;
	readonly host: EngineViewHost;
}

export function EngineViewInspector({processes, host}: EngineViewInspectorProps): ReactNode {
	const selected = useSelectedProcessId(host, engineViewSelection);
	return <ProcessDetailView detail={processDetail(processes, selected)} />;
}

export const engineViewInspectorRenderer = (
	processes: ReadonlyArray<ProcessRow>,
): InspectorRenderer<ReactNode, EngineViewState, EngineViewMsg, ViewState> =>
	inspectorRenderer("host-native", (host: EngineViewHost) => (
		<EngineViewInspector processes={processes} host={host} />
	));
