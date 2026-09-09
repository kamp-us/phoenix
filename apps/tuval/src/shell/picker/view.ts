/**
 * The picker's cursor model, and the one structure both the keyboard and the pointer write
 * through. Everything the picker "remembers" is the window's own view slot — a cursor, at most one
 * refusal, and the process the window was showing before it came back here — so the picker itself
 * holds nothing: `mountPicker` derives a fresh view from its one argument, which
 * is why a second mount after a registry change cannot show yesterday's list or yesterday's
 * highlight.
 *
 * The cursor indexes `flatten(entries)`, and it is resolved on every read rather than on write: the
 * list is re-read each mount and can shrink under a stored cursor (a process stops), and the read is
 * the only place that sees both the cursor and the list it must be valid against. `null` is the
 * cursor nobody has placed yet, which is why a mount can start on `previous`'s row without the
 * unbinding reducer — which cannot see the registry or the process table — knowing its index.
 */

import {Result} from "effect";
import {ProcessId} from "../../process/process.ts";
import {normalize} from "../keys/syntax.ts";
import type {WindowId} from "../window/host.ts";
import {flatten, type PickerEntries, type PickerEntry} from "./entries.ts";
import {attachProcess, intentOf, type PickerIntent} from "./intent.ts";
import {isPickerRefusal, type PickerRefusal} from "./refusal.ts";

/**
 * The window's view slot while it shows the picker. A type alias rather than an interface because
 * the slot is `Schema.Json`, and only an alias gets the implicit index signature that assignment
 * needs (TypeScript, "index signature inference").
 *
 * `previous` is typed `string` rather than `ProcessId` because the shell core writes it and types
 * every process id as a plain string for the same reason the layout tree does — the branded type
 * lives behind an Effect import neither module takes.
 */
export type PickerView = {
	/** `null` until something places it: the read resolves that to `previous`'s row, else the first. */
	readonly cursor: number | null;
	readonly refusal: PickerRefusal | null;
	/** The process this window was showing when `window:pick` put it back on the picker (#8265). */
	readonly previous: string | null;
};

/**
 * What a mount starts from. A function rather than a constant so no caller can hold a reference to
 * one shared object and mutate the next mount's starting point.
 */
export const mountPicker = (previous: string | null = null): PickerView => ({
	cursor: null,
	refusal: null,
	previous,
});

export const withRefusal = (view: PickerView, refusal: PickerRefusal): PickerView => ({
	...view,
	refusal,
});

/**
 * Read one window's view slot as the picker's. The slot is `Schema.Json` and any program may have
 * written it, so a fresh view is rebuilt field by field from what is actually there — never
 * narrowed by assertion, which would hand a foreign record to `pickerKey` typed as if it were
 * sound. A slot the picker did not write reads as `mountPicker()`, which is also what a first mount
 * starts from, and that is what an absent slot reads as too.
 */
export const asPickerView = (slot: unknown): PickerView => {
	if (typeof slot !== "object" || slot === null || Array.isArray(slot)) return mountPicker();
	const record: Record<string, unknown> = {...slot};
	const cursor = record.cursor;
	if (cursor !== null && typeof cursor !== "number") return mountPicker();
	const refusal = record.refusal;
	const previous = record.previous;
	return {
		cursor,
		refusal: isPickerRefusal(refusal) ? refusal : null,
		previous: typeof previous === "string" ? previous : null,
	};
};

const clamp = (cursor: number, length: number): number => {
	if (length === 0) return 0;
	if (!Number.isInteger(cursor) || cursor < 0) return 0;
	return cursor > length - 1 ? length - 1 : cursor;
};

/**
 * Where the highlight actually sits. An unplaced cursor lands on the row of the process this window
 * was showing, so `<c-b> w` mounts the picker pointing at where Escape would take the operator
 * back; a `previous` no row offers — the process exited while the picker was up — falls back to the
 * first row rather than to nothing.
 */
export const cursorOf = (entries: PickerEntries, view: PickerView): number => {
	const rows = flatten(entries);
	if (view.cursor !== null) return clamp(view.cursor, rows.length);
	if (view.previous === null) return 0;
	const at = rows.findIndex(
		(row) => row._tag === "Process" && String(row.processId) === view.previous,
	);
	return at === -1 ? 0 : at;
};

/** The row the cursor names, or `null` when there is nothing to name. */
export const highlighted = (entries: PickerEntries, view: PickerView): PickerEntry | null =>
	flatten(entries)[cursorOf(entries, view)] ?? null;

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
 * The one move. A move onto the row already under the cursor keeps a showing refusal, because
 * nothing has been moved on from; any other move clears it. Both inputs go through here, so hover
 * and the arrow keys cannot answer the same move two ways.
 */
const movedTo = (view: PickerView, at: number, next: number, length: number): PickerKeyAnswer =>
	length === 0 || next === at
		? {_tag: "Moved", view: {...view, cursor: at}}
		: {_tag: "Moved", view: {...view, cursor: next, refusal: null}};

/**
 * One key against the picker. `<arrow*>` are the ARIA listbox keys and `j`/`k`/`<c-n>`/`<c-p>` the
 * Vim and readline spellings of the same move, so the founder's muscle memory and a screen-reader
 * user's expected keys are one implementation rather than two.
 *
 * Movement clamps at both ends instead of wrapping, which is the APG listbox default: a wrap makes
 * "am I at the end" unanswerable to someone reading one option at a time.
 *
 * Escape is two keys in one, and the order is what makes both reachable: a refusal showing is
 * cleared first, and only a picker with nothing to dismiss goes back to `previous`. A `previous`
 * whose process has since stopped still chooses — `runPickerIntent`'s attach arm (`./open.ts`)
 * answers a missing row with a `ProcessGone` refusal shown in the window, which is the one place
 * the process table can be read.
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
	const at = cursorOf(entries, view);

	const moveTo = (next: number): PickerKeyAnswer => movedTo(view, at, next, rows.length);

	if (DOWN.includes(pressed)) return moveTo(clamp(at + 1, rows.length));
	if (UP.includes(pressed)) return moveTo(clamp(at - 1, rows.length));
	if (FIRST.includes(pressed)) return moveTo(0);
	if (LAST.includes(pressed)) return moveTo(clamp(rows.length - 1, rows.length));
	if (DISMISS.includes(pressed)) {
		if (view.refusal !== null) {
			return {_tag: "Cleared", view: {...view, cursor: at, refusal: null}};
		}
		return view.previous === null
			? ignored
			: {_tag: "Chose", intent: attachProcess(windowId, ProcessId.make(view.previous))};
	}
	if (CHOOSE.includes(pressed)) {
		const entry = rows[at];
		return entry === undefined ? ignored : {_tag: "Chose", intent: intentOf(windowId, entry)};
	}
	return ignored;
};

/**
 * What a pointer did to one row. `hover` is the pointer landing on it, `click` the commit — the two
 * gestures a `role="option"` offers, and nothing else: a listbox driven by `aria-activedescendant`
 * has no per-option focus to model.
 */
export type PickerPointer = "hover" | "click";

/**
 * One pointer gesture against the picker, answered in `pickerKey`'s own union so the surface has a
 * single switch to dispatch (founder's ruling, 2026-09-08: one underlying structure for both
 * inputs). `index` addresses `flatten(entries)` — the same list the cursor indexes — so a hover and
 * an arrow key that land on one row store the same view, and `aria-activedescendant` stays the one
 * highlight either way.
 *
 * An index naming no row is `Ignored` rather than clamped: a pointer event carries a row that was
 * really under it, so an out-of-range index means the list changed under the gesture, and moving
 * the cursor somewhere the user never pointed at is worse than doing nothing.
 */
export const pickerPointer = (
	windowId: WindowId,
	entries: PickerEntries,
	view: PickerView,
	index: number,
	gesture: PickerPointer,
): PickerKeyAnswer => {
	const rows = flatten(entries);
	const entry = rows[index];
	if (entry === undefined) return ignored;
	return gesture === "click"
		? {_tag: "Chose", intent: intentOf(windowId, entry)}
		: movedTo(view, cursorOf(entries, view), index, rows.length);
};
