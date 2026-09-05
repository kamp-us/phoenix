/**
 * The picker's keyboard model. Everything the picker "remembers" is the window's own view slot — a
 * cursor and at most one refusal — so the picker itself holds nothing: `mountPicker` derives a
 * fresh view from nothing at all, which is why a second mount after a registry change cannot show
 * yesterday's list or yesterday's highlight.
 *
 * The cursor indexes `flatten(entries)`, and it is clamped on every read rather than on write: the
 * list is re-read each mount and can shrink under a stored cursor (a process stops), and a clamp at
 * the read is the only place that sees both the cursor and the list it must be valid against.
 */

import {Result} from "effect";
import {normalize} from "../keys/syntax.ts";
import type {WindowId} from "../window/host.ts";
import {flatten, type PickerEntries, type PickerEntry} from "./entries.ts";
import {intentOf, type PickerIntent} from "./intent.ts";
import type {PickerRefusal} from "./refusal.ts";

/**
 * The window's view slot while it shows the picker. A type alias rather than an interface because
 * the slot is `Schema.Json`, and only an alias gets the implicit index signature that assignment
 * needs (TypeScript, "index signature inference").
 */
export type PickerView = {
	readonly cursor: number;
	readonly refusal: PickerRefusal | null;
};

/**
 * What a mount starts from. A function rather than a constant so no caller can hold a reference to
 * one shared object and mutate the next mount's starting point.
 */
export const mountPicker = (): PickerView => ({cursor: 0, refusal: null});

export const withRefusal = (view: PickerView, refusal: PickerRefusal): PickerView => ({
	...view,
	refusal,
});

const clamp = (cursor: number, length: number): number => {
	if (length === 0) return 0;
	if (!Number.isInteger(cursor) || cursor < 0) return 0;
	return cursor > length - 1 ? length - 1 : cursor;
};

/** The row the cursor names, or `null` when there is nothing to name. */
export const highlighted = (entries: PickerEntries, view: PickerView): PickerEntry | null => {
	const rows = flatten(entries);
	return rows[clamp(view.cursor, rows.length)] ?? null;
};

export const cursorOf = (entries: PickerEntries, view: PickerView): number =>
	clamp(view.cursor, flatten(entries).length);

/**
 * What one key did. `Moved` and `Cleared` carry the view to store; `Chose` carries the intent to
 * run; `Ignored` says this key was never the picker's, so the surface may pass it on.
 */
export type PickerKeyAnswer =
	| {readonly _tag: "Moved"; readonly view: PickerView}
	| {readonly _tag: "Cleared"; readonly view: PickerView}
	| {readonly _tag: "Chose"; readonly intent: PickerIntent}
	| {readonly _tag: "Ignored"};

const ignored: PickerKeyAnswer = {_tag: "Ignored"};

const DOWN = ["<arrowdown>", "j", "<c-n>", "<tab>"];
const UP = ["<arrowup>", "k", "<c-p>", "<s-tab>"];
const FIRST = ["<home>", "g"];
const LAST = ["<end>", "G"];
const CHOOSE = ["<enter>", "<space>"];
const DISMISS = ["<escape>"];

/**
 * One key against the picker. `<arrow*>` are the ARIA listbox keys and `j`/`k`/`<c-n>`/`<c-p>` the
 * Vim and readline spellings of the same move, so the founder's muscle memory and a screen-reader
 * user's expected keys are one implementation rather than two.
 *
 * Movement clamps at both ends instead of wrapping, which is the APG listbox default: a wrap makes
 * "am I at the end" unanswerable to someone reading one option at a time.
 */
export const pickerKey = (
	windowId: WindowId,
	entries: PickerEntries,
	view: PickerView,
	key: string,
): PickerKeyAnswer => {
	const spelled = normalize(key);
	if (Result.isFailure(spelled)) return ignored;
	const pressed = spelled.success;
	const rows = flatten(entries);
	const at = clamp(view.cursor, rows.length);

	const moveTo = (next: number): PickerKeyAnswer =>
		rows.length === 0 || next === at
			? {_tag: "Moved", view: {...view, cursor: at}}
			: {_tag: "Moved", view: {cursor: next, refusal: null}};

	if (DOWN.includes(pressed)) return moveTo(clamp(at + 1, rows.length));
	if (UP.includes(pressed)) return moveTo(clamp(at - 1, rows.length));
	if (FIRST.includes(pressed)) return moveTo(0);
	if (LAST.includes(pressed)) return moveTo(clamp(rows.length - 1, rows.length));
	if (DISMISS.includes(pressed)) {
		return view.refusal === null ? ignored : {_tag: "Cleared", view: {cursor: at, refusal: null}};
	}
	if (CHOOSE.includes(pressed)) {
		const entry = rows[at];
		return entry === undefined ? ignored : {_tag: "Chose", intent: intentOf(windowId, entry)};
	}
	return ignored;
};
