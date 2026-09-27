/**
 * One workspace holding windows from two open projects and a global program, in a real browser
 * (#9692, ruling #9668 R1.1). A project owns no workspace, so the capture this page exists for is the
 * mix: each window's title row carries its own project's label, and the global program's carries
 * none. The board's tiles are `./main.tsx`; the projects are the same two (`./projects.ts`).
 *
 * The windows are the real `WindowView` on its real `Bound` arm, as the picker's proof does it
 * (`../../picker/proof/main.tsx`), with a renderer that draws one line: what is judged here is the
 * title row, not a program. The mounts go through `boundMount`, the constructor the page's own
 * resolver calls (`../../../page/AttachedDesk.tsx`), so a pane cannot drift from the arm it claims.
 */

import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {type AnyWindowHost, WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {boundMount} from "../../ui/mount.ts";
import {WindowView} from "../../ui/WindowView.tsx";
import {kampUs, projects, usirin} from "./projects.ts";
import "../../../page/styles.ts";
import "./proof.css";

const hostOf = (windowId: string, processId: string): AnyWindowHost => ({
	windowId: WindowId.make(windowId),
	processId: ProcessId.make(processId),
	readProcess: undefined as never,
	dispatch: undefined as never,
	view: () => null,
	setView: undefined as never,
});

function Pane({
	window,
	process,
	programId,
	title,
	body,
	focused,
}: {
	readonly window: string;
	readonly process: string;
	readonly programId: string;
	/** The process's `title@1` line, or `null` for one that published none. */
	readonly title: string | null;
	readonly body: string;
	readonly focused: boolean;
}) {
	const mount = boundMount(
		hostOf(window, process),
		() => <p className="proof-window-line">{body}</p>,
		{title, program: projects.programName(programId)},
		projects.labelOf(programId),
	);
	return (
		<div className="proof-pane">
			<WindowView
				windowId={WindowId.make(window)}
				mount={mount}
				focused={focused}
				view={undefined}
				entries={{programs: [], processes: []}}
				dispatch={(msg) => globalThis.console.log(msg.type)}
				reducedMotion={false}
			/>
		</div>
	);
}

const host = document.getElementById("proof");
if (host === null) throw new Error("the proof page has no #proof element");

createRoot(host).render(
	<StrictMode>
		<div className="tuval-surface proof-desk proof-workspace" data-scheme="dark">
			<Pane
				window="window-1"
				process="p-claude"
				programId={kampUs("ai/claude")}
				title="claude · fable · phoenix"
				body="writing the tile model"
				focused={true}
			/>
			{/* No title published, so the window is named by its program: the declared id, since the
			    label beside it already says which checkout. */}
			<Pane
				window="window-2"
				process="p-counter"
				programId={usirin("demo/counter")}
				title={null}
				body="count: 12"
				focused={false}
			/>
			<Pane
				window="window-3"
				process="p-log"
				programId="demo/log"
				title="log"
				body="a global program: no project, so no label"
				focused={false}
			/>
		</div>
	</StrictMode>,
);
