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
import type {PickerEntries} from "../picker/browser.ts";
import type {ViewState, WindowId} from "../window/index.ts";
import type {WindowMount} from "./mount.ts";
import {asPickerView, PickerView} from "./PickerView.tsx";

export interface WindowViewProps {
	readonly windowId: WindowId;
	readonly mount: WindowMount;
	readonly focused: boolean;
	readonly view: ViewState | undefined;
	readonly entries: PickerEntries;
	readonly dispatch: (msg: ShellMsg) => void;
	readonly reducedMotion: boolean;
}

const titleOf = (mount: WindowMount): string => {
	switch (mount._tag) {
		case "Bound":
			return `process ${mount.host.processId}`;
		case "NoRenderer":
			return `process ${mount.processId}`;
		case "ProcessGone":
			return `process ${mount.processId} — gone`;
		case "Empty":
			return "empty window";
	}
};

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
				<span>{titleOf(mount)}</span>
				{focused ? <span>(focused)</span> : null}
			</header>
			<div className="tuval-window-body">
				{mount._tag === "Bound" ? (
					mount.render(mount.host)
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
