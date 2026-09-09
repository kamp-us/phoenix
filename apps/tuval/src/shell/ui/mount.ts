/**
 * What one window shows, resolved outside React. `WindowSlot` (`../window/host.ts`) already names
 * the three arms — a bound host, a gone process, an empty window — and this adds the one thing a
 * browser surface needs beside them: the React renderer the bound host's program declared.
 *
 * The resolution happens here rather than in the component because it needs the registry and the
 * transport, and a component that reached for either would be untestable without both. The desk
 * takes a `MountResolver` and asks it per window; a test hands over a table.
 */

import type {ReactNode} from "react";
import type {ProcessId} from "../../process/process.ts";
import type {ProgramId} from "../../registry/program.ts";
import type {AnyWindowHost, Empty, ProcessGone, WindowId} from "../window/index.ts";

/** A program's window renderer, at the surface's own output type. */
export type ReactWindowRenderer = (host: AnyWindowHost) => ReactNode;

/**
 * What names a window showing a live process: the newest line that process published on its
 * `title@1` port, and the program running it — the fallback when it has published none.
 *
 * The two arms below carry `ProcessName | null` rather than this type carrying its own absence,
 * because "this desk does not name its windows" and "this process has said nothing" are different
 * facts. `null` is the first: the `windowTitles` flag is off, and the window keeps the
 * `process <uuid>` title it had before #8721.
 */
export interface ProcessName {
	readonly title: string | null;
	readonly programId: ProgramId;
}

export type WindowMount =
	| {
			readonly _tag: "Bound";
			readonly host: AnyWindowHost;
			readonly render: ReactWindowRenderer;
			readonly name: ProcessName | null;
	  }
	/**
	 * The process is live and its program declares no renderer, or names one this surface's table
	 * does not hold. A window, not a hole: the placeholder says which, so `NoRenderer` is not
	 * silently rendered as `ProcessGone` — the process is running and the window simply cannot show
	 * it (`../window/renderer.ts`, `RendererResolution`).
	 */
	| {
			readonly _tag: "NoRenderer";
			readonly processId: ProcessId;
			readonly reason: string;
			readonly name: ProcessName | null;
	  }
	| ProcessGone
	| Empty;

/**
 * How the desk turns a window into what it shows. `processId` is the tree's own `string | null`,
 * so a resolver sees exactly what the layout holds and decides the `Empty` arm itself.
 */
export type MountResolver = (windowId: WindowId, processId: string | null) => WindowMount;

export const noRenderer = (
	processId: ProcessId,
	reason: string,
	name: ProcessName | null = null,
): WindowMount => ({
	_tag: "NoRenderer",
	processId,
	reason,
	name,
});

export const boundMount = (
	host: AnyWindowHost,
	render: ReactWindowRenderer,
	name: ProcessName | null = null,
): WindowMount => ({
	_tag: "Bound",
	host,
	render,
	name,
});
