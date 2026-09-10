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
 *
 * The filter `/` opens is the one exception, and it is the command line's own shape (#8450): while
 * it holds focus the desk leaves it every press (`./text-entry.ts`), so the four keys the picker
 * still owns there — Enter, Escape and the two arrows — are read off the input's own `onKeyDown`
 * and answered by the same `pickerKey`. That is a React prop, not a second document listener.
 */

import type {KeyboardEvent, ReactElement} from "react";
import {useCallback, useEffect, useRef, useState} from "react";
import type {ShellMsg} from "../core/index.ts";
import {
	type PickerEntries,
	type PickerKeyAnswer,
	type PickerView as PickerViewState,
	pickerFrame,
	pickerKey,
	pickerPointer,
	withFilter,
} from "../picker/browser.ts";
import type {WindowId} from "../window/index.ts";
import {useForwardedKey} from "./forwarded-key.tsx";
import {isTextEntry} from "./text-entry.ts";

/**
 * How long the typing has to stop before the match count is announced. Founder-ruled on #8450:
 * announcing per keystroke turns one search into a run of interruptions. GOV.UK's
 * accessible-autocomplete waits 1400 ms for the same reason; this list is local and instant, so
 * ours is shorter.
 */
const ANNOUNCE_PAUSE_MS = 1_000;

/** The keys the picker still answers while the caret is in the filter, by their DOM `key`. */
const FILTER_KEYS: Readonly<Record<string, string>> = {
	Enter: "<enter>",
	Escape: "<escape>",
	ArrowDown: "<arrowdown>",
	ArrowUp: "<arrowup>",
};

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
	const filterInput = useRef<HTMLInputElement>(null);

	// Never off the command line's input: the desk hands that surface focus deliberately, and a
	// picker that grabbed it back would eat the line the user is typing.
	const takeFocus = useCallback(() => {
		const node = listbox.current;
		if (node === null) return;
		const active = node.ownerDocument.activeElement;
		if (active === node || isTextEntry(active)) return;
		node.focus({preventScroll: true});
	}, []);

	// The two ends of the picker's focus, in one place so they cannot both claim it: `/` moves the
	// caret into the filter and Escape hands it straight back to the listbox, which is the element
	// `aria-activedescendant` has to be announced off.
	const filtering = frame.filter !== null;
	useEffect(() => {
		if (!focused) return;
		if (filtering) filterInput.current?.focus({preventScroll: true});
		else takeFocus();
	}, [filtering, focused, takeFocus]);

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

	// The count, held back until the typing stops, and written into the two status regions by turns.
	// The turn is what re-announces a count that did not change: a live region whose text is
	// rewritten with the same string is not a change, so nothing is read out (GOV.UK's status
	// component technique, founder-ruled on #8450).
	const [announced, setAnnounced] = useState<{readonly text: string; readonly slot: 0 | 1}>({
		text: "",
		slot: 1,
	});
	const announcement = frame.announcement;
	const regions = announcement.role === "status" ? announcement.alternates : null;
	// A boolean rather than the id pair: the frame mints a fresh array every render, and an effect
	// keyed on it would re-arm the pause on renders nobody typed into.
	const alternating = regions !== null;
	const countText = announcement.text;
	// The query and not only the text: two different queries can leave the same count, and that is
	// exactly the announcement the alternation exists to repeat.
	const query = frame.filter?.value ?? null;
	useEffect(() => {
		if (!alternating || query === null) return;
		const timer = setTimeout(() => {
			setAnnounced((previous) => ({text: countText, slot: previous.slot === 0 ? 1 : 0}));
		}, ANNOUNCE_PAUSE_MS);
		return () => clearTimeout(timer);
	}, [alternating, query, countText]);

	const run = useCallback(
		(answer: PickerKeyAnswer) => {
			switch (answer._tag) {
				case "Moved":
				case "Cleared":
				case "Filtering":
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

	// The caret is in the filter, so the desk left this press here (`./text-entry.ts`). Only the four
	// keys the picker still owns are taken; every other one — `j`, `k`, `g`, `G` included — is a
	// character the operator is typing and stays the input's.
	const onFilterKeyDown = useCallback(
		(event: KeyboardEvent<HTMLInputElement>) => {
			const spelled = FILTER_KEYS[event.key];
			if (spelled === undefined) return;
			event.preventDefault();
			run(pickerKey(windowId, entries, view, spelled));
		},
		[entries, run, view, windowId],
	);

	useForwardedKey(windowId, (key) => {
		// A forwarded key means the desk considers this window focused. Re-claiming here is what
		// carries focus back after the command line closes onto the desk container.
		takeFocus();
		run(pickerKey(windowId, entries, view, key));
	});

	return (
		<div className="tuval-picker">
			{frame.filter === null ? null : (
				<div className="tuval-picker-filter">
					<label htmlFor={frame.filter.id} aria-hidden="true">
						/
					</label>
					{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is an expression, so the
					    rule judges the input's implicit `textbox`; `combobox` is what `pickerFrame` says
					    and what the element carries, and `aria-expanded` is required on it */}
					<input
						id={frame.filter.id}
						ref={filterInput}
						type="text"
						// The focus holder while it exists, so it is the element the highlight is announced
						// off — the listbox below drops `aria-activedescendant` for exactly as long.
						role={frame.filter.role}
						aria-expanded={frame.filter.expanded}
						aria-autocomplete={frame.filter.autocomplete}
						aria-controls={frame.filter.controls}
						aria-activedescendant={frame.activeDescendant ?? undefined}
						value={frame.filter.value}
						autoComplete="off"
						spellCheck={false}
						placeholder={frame.filter.placeholder}
						aria-label={frame.filter.label}
						onChange={(event) =>
							dispatch({
								type: "window.setView",
								windowId,
								view: withFilter(view, event.target.value),
							})
						}
						onKeyDown={onFilterKeyDown}
					/>
				</div>
			)}
			<div
				ref={listbox}
				role="listbox"
				id={frame.id}
				aria-label={frame.label}
				aria-activedescendant={filtering ? undefined : (frame.activeDescendant ?? undefined)}
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
			{regions === null ? (
				<p
					className="tuval-refusal"
					role={announcement.role}
					aria-live={announcement.live}
					{...(announcement.role === "status" ? {"aria-atomic": true} : {})}
				>
					{announcement.text}
				</p>
			) : (
				// Two regions, written into by turns. Both are always in the DOM — a live region added to
				// the page at the same moment its text arrives is announced by nothing.
				regions.map((id, slot) => (
					<p
						key={id}
						id={id}
						className="tuval-refusal"
						role="status"
						aria-live="polite"
						aria-atomic="true"
					>
						{announced.slot === slot ? announced.text : ""}
					</p>
				))
			)}
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
