/**
 * The mode control: what the session is in, and what else it could be.
 *
 * `Select` from `@kampus/design` is the Zag-driven listbox — it owns the keyboard, the typeahead
 * and the dismissal, and its `label` prop is the control's accessible name
 * (`.patterns/manti-accessibility.md`). Nothing here names a mode: the strings are the program's
 * own (`ModePayload`), so a backend that offers "plan" and "build" and one that offers neither read
 * the same to this component.
 *
 * A program that offers none advertises an empty `available` (`../../ai-agent/ports/payloads.ts`),
 * and then there is no control at all — a listbox with nothing to pick is a control that lies about
 * being operable.
 */

import {Select} from "@kampus/design";
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
	const items = modes.available.map((mode) => ({value: mode, label: mode}));
	return (
		<div className="tuval-chat-mode">
			<Select
				items={items}
				label="Mode"
				size="sm"
				placeholder="pick a mode"
				value={modes.current === null ? [] : [modes.current]}
				onValueChange={(value) => {
					// `Mode` is branded, and `Select` answers in plain strings — so the picked value is
					// looked up in the offered list rather than cast. A value that is not on offer is a
					// value this control never rendered, and dropping it here means the `setMode` the
					// core refuses (`ModeUnsupported`) is one the window cannot send in the first place.
					const next = modes.available.find((mode) => mode === value[0]);
					if (next !== undefined && next !== modes.current) onSetMode(next);
				}}
			/>
		</div>
	);
}
