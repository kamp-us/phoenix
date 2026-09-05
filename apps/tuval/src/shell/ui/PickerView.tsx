/**
 * The picker, bound to elements. It decides nothing: `pickerFrame` (`../picker/frame.ts`) already
 * said the roles, the accessible names, the active descendant and the live region, and this file
 * spells them as DOM. Keys go through `pickerKey`, whose answers are the only writes.
 *
 * The listbox is the focus holder, not each option — that is the `aria-activedescendant` pattern,
 * and it is what keeps the desk's single keyboard listener the only listener: the options are not
 * tabbable and none of them listens. "Focus holder" is literal and it has to be: assistive tech
 * announces `aria-activedescendant` only off the element that actually has DOM focus, so a listbox
 * nothing ever focused moves a highlight nobody hears (#7499). Taking focus is not a second
 * listener — the desk's document listener still sees every press, because a `div` is not a text
 * entry and the key never stops there.
 */

import type {ReactElement} from "react";
import {useCallback, useEffect, useRef} from "react";
import type {ShellMsg} from "../core/index.ts";
import {
	isPickerRefusal,
	mountPicker,
	type PickerEntries,
	type PickerView as PickerViewState,
	pickerFrame,
	pickerKey,
} from "../picker/index.ts";
import type {WindowId} from "../window/index.ts";
import {useForwardedKey} from "./forwarded-key.tsx";
import {isTextEntry} from "./text-entry.ts";

export interface PickerViewProps {
	readonly windowId: WindowId;
	readonly entries: PickerEntries;
	/** The window's own view slot, already narrowed. A slot holding anything else starts fresh. */
	readonly view: PickerViewState;
	readonly dispatch: (msg: ShellMsg) => void;
	readonly reducedMotion: boolean;
	/** Whether this window is the desk's focused one — the picker holds DOM focus only then. */
	readonly focused: boolean;
}

/**
 * Is this view slot the picker's? The slot is `Schema.Json` and any program may have written it, so
 * a fresh view is rebuilt field by field from what is actually there — never narrowed by assertion,
 * which would hand a foreign record to `pickerKey` typed as if it were sound. A slot the picker did
 * not write reads as `mountPicker()`, which is also what a first mount starts from.
 */
export const asPickerView = (slot: unknown): PickerViewState => {
	if (typeof slot !== "object" || slot === null || Array.isArray(slot)) return mountPicker();
	const record: Record<string, unknown> = {...slot};
	if (typeof record.cursor !== "number") return mountPicker();
	const refusal = record.refusal;
	return {cursor: record.cursor, refusal: isPickerRefusal(refusal) ? refusal : null};
};

export function PickerView({
	windowId,
	entries,
	view,
	dispatch,
	reducedMotion,
	focused,
}: PickerViewProps): ReactElement {
	const frame = pickerFrame(windowId, entries, view, {reducedMotion});
	const listbox = useRef<HTMLDivElement>(null);

	// Never off the command line's input: the desk hands that surface focus deliberately, and a
	// picker that grabbed it back would eat the line the user is typing.
	const takeFocus = useCallback(() => {
		const node = listbox.current;
		if (node === null) return;
		const active = node.ownerDocument.activeElement;
		if (active === node || isTextEntry(active)) return;
		node.focus({preventScroll: true});
	}, []);

	useEffect(() => {
		if (focused) takeFocus();
	}, [focused, takeFocus]);

	useForwardedKey(windowId, (key) => {
		// A forwarded key means the desk considers this window focused. Re-claiming here is what
		// carries focus back after the command line closes onto the desk container.
		takeFocus();
		const answer = pickerKey(windowId, entries, view, key);
		switch (answer._tag) {
			case "Moved":
			case "Cleared":
				dispatch({type: "window.setView", windowId, view: answer.view});
				return;
			case "Chose":
				dispatch(
					answer.intent._tag === "OpenProgram"
						? {type: "window.open", windowId, programId: answer.intent.programId}
						: {type: "window.attach", windowId, processId: answer.intent.processId},
				);
				return;
			case "Ignored":
				return;
		}
	});

	return (
		<div className="tuval-picker">
			<div
				ref={listbox}
				role="listbox"
				id={frame.id}
				aria-label={frame.label}
				aria-activedescendant={frame.activeDescendant ?? undefined}
				tabIndex={-1}
			>
				{frame.groups.map((group) => (
					// A `group` inside a `listbox` holding `option`s is the APG shape, and it is the shape
					// `pickerFrame` already declared. The native equivalents biome offers — `fieldset`,
					// `optgroup` — are a form control and a `select` child; neither is legal here, and the
					// options are deliberately not tabbable because focus stays on the listbox and moves by
					// `aria-activedescendant`.
					// biome-ignore lint/a11y/useSemanticElements: no native element carries `group` inside a listbox
					<div key={group.id} role="group" aria-labelledby={`${group.id}-label`}>
						<div className="tuval-picker-group-label" id={`${group.id}-label`}>
							{group.label}
						</div>
						{group.emptyMessage === null ? null : (
							<p className="tuval-refusal">{group.emptyMessage}</p>
						)}
						{group.options.map((option) => (
							// biome-ignore lint/a11y/useFocusableInteractive: activedescendant options are not tabbable
							<div
								key={option.id}
								id={option.id}
								role="option"
								aria-selected={option.selected}
								aria-label={option.name}
							>
								<span aria-hidden="true">{option.marker}</span>
								<span>{option.name}</span>
								<span className="tuval-picker-detail">{option.detail}</span>
							</div>
						))}
					</div>
				))}
			</div>
			<p
				className="tuval-refusal"
				role={frame.announcement.role}
				aria-live={frame.announcement.live}
			>
				{frame.announcement.text}
			</p>
			<dl className="tuval-refusal">
				{frame.keyHelp.map((help) => (
					<div key={help.keys}>
						<dt>
							<kbd className="tuval-kbd">{help.keys}</kbd>
						</dt>
						<dd>{help.action}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
