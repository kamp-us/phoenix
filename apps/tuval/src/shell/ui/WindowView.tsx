/**
 * One window: its title row, and whichever of the window contract's three arms it is showing
 * (`../window/host.ts`). The arms are the whole vocabulary — a bound host mounts its program's
 * renderer, an empty window mounts the picker, a gone process gets the placeholder — and there is
 * no fourth branch and no throw, because both fallbacks are values the contract already names.
 *
 * The focused marker is carried twice: `data-focused` paints the border, and the `▸` in the title
 * plus `aria-current` say the same thing without colour (`design-system-manifest.md`, Pillar 4).
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
