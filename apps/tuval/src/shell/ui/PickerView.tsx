/**
 * The picker, bound to elements. It decides nothing: `pickerFrame` (`../picker/frame.ts`) already
 * said the roles, the accessible names, the active descendant and the live region, and this file
 * spells them as DOM. Keys go through `pickerKey` and pointer gestures through `pickerPointer`,
 * which answer in one union that `run` below is the only reader of — so the mouse writes nothing
 * the keyboard could not have written, and `aria-activedescendant` stays the one highlight both
 * inputs move (#8655).
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
	type PickerEntries,
	type PickerKeyAnswer,
	type PickerView as PickerViewState,
	pickerFrame,
	pickerKey,
	pickerPointer,
} from "../picker/browser.ts";
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

	// Nothing else moves the scroll port: the listbox holds focus and the options are untabbable, so
	// the browser never scrolls a row into view on its own and the highlight walks out of
	// `.tuval-window-body` (#8656). `block: "nearest"` scrolls instantly and only when the row is off
	// screen, which is why `reducedMotion` gets no say here.
	const activeDescendant = frame.activeDescendant;
	useEffect(() => {
		if (activeDescendant === null) return;
		listbox.current?.ownerDocument
			.getElementById(activeDescendant)
			?.scrollIntoView({block: "nearest"});
	}, [activeDescendant]);

	const run = useCallback(
		(answer: PickerKeyAnswer) => {
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
		},
		[dispatch, windowId],
	);

	useForwardedKey(windowId, (key) => {
		// A forwarded key means the desk considers this window focused. Re-claiming here is what
		// carries focus back after the command line closes onto the desk container.
		takeFocus();
		run(pickerKey(windowId, entries, view, key));
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
							// biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard equivalent is `<enter>`, which the desk forwards to the listbox
							<div
								key={option.id}
								id={option.id}
								role="option"
								aria-selected={option.selected}
								aria-label={option.name}
								onPointerEnter={() =>
									run(pickerPointer(windowId, entries, view, option.index, "hover"))
								}
								onClick={() => {
									// A click must not cost the listbox its focus, or the next key press goes
									// nowhere and `aria-activedescendant` is announced off nothing (#7499).
									takeFocus();
									run(pickerPointer(windowId, entries, view, option.index, "click"));
								}}
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
