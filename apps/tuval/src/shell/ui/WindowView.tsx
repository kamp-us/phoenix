/**
 * One window: its title row, and whichever of the window contract's three arms it is showing
 * (`../window/host.ts`). The arms are the whole vocabulary — a bound host mounts its program's
 * renderer, an empty window mounts the picker, a gone process gets the placeholder — and there is
 * no fourth branch and no throw, because both fallbacks are values the contract already names.
 *
 * The focused marker is carried twice: `data-focused` paints the border, and the `▸` in the title
 * plus `aria-current` say the same thing without colour (`design-system-manifest.md`, Pillar 4).
 *
 * A pointer-down here is the mouse's whole route to focus (#7848): it dispatches `window.focus` and
 * does nothing else — no `preventDefault`, no `focus()` call, no tabindex. That restraint is the
 * design. The gesture's own default still lands DOM focus wherever it pointed, so a click into a
 * renderer's composer focuses the window without moving the caret out of it, and the focused
 * window's picker claims DOM focus off the next snapshot (`./PickerView.tsx`) rather than from a
 * second focus mechanism racing this one.
 */

import type {ReactElement} from "react";
import type {ShellMsg} from "../core/index.ts";
import {asPickerView, type PickerEntries} from "../picker/browser.ts";
import type {ViewState, WindowId} from "../window/index.ts";
import {ErrorBoundary} from "./ErrorBoundary.tsx";
import type {WindowMount} from "./mount.ts";
import {PickerView} from "./PickerView.tsx";
import {windowTitle} from "./window-title.ts";

export interface WindowViewProps {
	readonly windowId: WindowId;
	readonly mount: WindowMount;
	readonly focused: boolean;
	readonly view: ViewState | undefined;
	readonly entries: PickerEntries;
	readonly dispatch: (msg: ShellMsg) => void;
	readonly reducedMotion: boolean;
}

/**
 * The renderer's call, made inside the boundary below rather than in `WindowView`'s own render.
 * `mount.render(mount.host)` is a call, not an element, so making it where the boundary's child is
 * built would put the throw in the parent's render — above the boundary, where only the desk-level
 * one catches it, which is the blast radius #8157 is about.
 */
function RenderedWindow({
	mount,
}: {
	readonly mount: Extract<WindowMount, {readonly _tag: "Bound"}>;
}): ReactElement {
	return <>{mount.render(mount.host)}</>;
}

export function WindowView({
	windowId,
	mount,
	focused,
	view,
	entries,
	dispatch,
	reducedMotion,
}: WindowViewProps): ReactElement {
	return (
		<section
			className="tuval-window"
			// Already the focused window: the Msg would be a no-op in the core, and sending it anyway
			// would put a snapshot on the wire for every click a founder makes inside one window.
			onPointerDown={focused ? undefined : () => dispatch({type: "window.focus", windowId})}
			data-focused={focused}
			data-window-id={windowId}
			aria-label={`Window ${windowId}`}
			{...(focused ? {"aria-current": "true" as const} : {})}
		>
			<header className="tuval-window-title">
				<span aria-hidden="true">{focused ? "▸" : " "}</span>
				<span>{windowTitle(mount)}</span>
				{focused ? <span>(focused)</span> : null}
			</header>
			<div className="tuval-window-body">
				{mount._tag === "Bound" ? (
					// One boundary per window, so a renderer that throws costs the founder this window and
					// not the desk (#8157). The key is the process's identity and nothing per-render: the
					// boundary compares keys with `Object.is`, and one that moved on every snapshot would
					// tear the panel down under the reader (`./Desk.tsx`). A window still bound to the
					// process that threw recovers on the panel's own button.
					<ErrorBoundary
						label={`Process ${mount.host.processId}`}
						className="tuval-window-boundary"
						resetKeys={[mount.host.processId]}
					>
						<RenderedWindow mount={mount} />
					</ErrorBoundary>
				) : mount._tag === "Empty" ? (
					<PickerView
						windowId={windowId}
						entries={entries}
						view={asPickerView(view)}
						dispatch={dispatch}
						reducedMotion={reducedMotion}
						focused={focused}
					/>
				) : (
					<div className="tuval-placeholder" role="status">
						<p>
							{mount._tag === "ProcessGone"
								? `Process ${mount.processId} is gone. The window is still yours — open something else in it.`
								: `Process ${mount.processId} is running, but ${mount.reason}.`}
						</p>
					</div>
				)}
			</div>
		</section>
	);
}
