/**
 * The mode control: what the session is in, and what else it could be.
 *
 * It lives in the composer's settings fieldset, beside the model and thinking pickers (#8190,
 * founder ruling 2026-09-05) — the chat bar above the transcript carries the status line and
 * nothing else. `AgentSettingMenu` from `@kampus/design` is the shape those two pickers already
 * use, so the row reads as one set of controls rather than as a foreign one wedged in; the
 * primitive owns the keyboard, the dismissal and the accessible name it composes from `label` and
 * the current value.
 *
 * Nothing here names a mode: the strings are the program's own (`ModePayload`), so a backend that
 * offers "plan" and "build" and one that offers neither read the same to this component.
 *
 * A program that offers none advertises an empty `available` (`../../ai-agent/ports/payloads.ts`),
 * and then there is no control at all — a picker with nothing to pick is a control that lies about
 * being operable. That is a divergence from the model and thinking pickers, which render disabled
 * rather than absent (#8062): every backend has a model and a thinking level, and a mode is the one
 * setting a backend may genuinely not have.
 */

import {type AgentSettingItem, AgentSettingMenu} from "@kampus/design";
import type {ReactElement} from "react";
import type {ModeState} from "../../ai-agent/core/index.ts";
import type {Mode} from "../../ai-agent/ports/index.ts";

export function ModeSwitch({
	modes,
	onSetMode,
}: {
	readonly modes: ModeState;
	readonly onSetMode: (mode: Mode) => void;
}): ReactElement | null {
	if (modes.available.length === 0) return null;
	const items: AgentSettingItem[] = modes.available.map((mode) => ({value: mode, label: mode}));
	return (
		<div className="tuval-chat-mode">
			<AgentSettingMenu
				label="Mode"
				items={items}
				{...(modes.current === null ? {} : {value: modes.current})}
				disabled={modes.available.length < 2}
				onValueChange={(value) => {
					// `Mode` is branded, and the picker answers in plain strings — so the picked value is
					// looked up in the offered list rather than cast. A value that is not on offer is a
					// value this control never rendered, and dropping it here means the `setMode` the
					// core refuses (`ModeUnsupported`) is one the window cannot send in the first place.
					const next = modes.available.find((mode) => mode === value);
					if (next !== undefined && next !== modes.current) onSetMode(next);
				}}
			/>
		</div>
	);
}
