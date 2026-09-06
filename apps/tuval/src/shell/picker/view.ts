/**
 * The picker's keyboard model. Everything the picker "remembers" is the window's own view slot — a
 * cursor, at most one refusal, and the process the window was showing before it came back here — so
 * the picker itself holds nothing: `mountPicker` derives a fresh view from its one argument, which
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

	const moveTo = (next: number): PickerKeyAnswer =>
		rows.length === 0 || next === at
			? {_tag: "Moved", view: {...view, cursor: at}}
			: {_tag: "Moved", view: {...view, cursor: next, refusal: null}};

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
