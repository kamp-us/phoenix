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

import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import type {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/host";
import {Result} from "effect";
import {normalize} from "../keys/syntax.ts";
import {flatten, type PickerEntries, type PickerEntry} from "./entries.ts";
import {type PickerFilter, visibleEntries} from "./filter.ts";
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
	/** `null` until `/` opens it; a string once open, and every mount opens with none (#8450). */
	readonly filter: PickerFilter;
};

/**
 * What a mount starts from. A function rather than a constant so no caller can hold a reference to
 * one shared object and mutate the next mount's starting point.
 */
export const mountPicker = (previous: string | null = null): PickerView => ({
	cursor: null,
	refusal: null,
	previous,
	filter: null,
});

export const withRefusal = (view: PickerView, refusal: PickerRefusal): PickerView => ({
	...view,
	refusal,
});

/**
 * The view one edit of the filter input leaves. The cursor goes back to unplaced rather than being
 * carried: the row under index 2 of the old match set is not the row under index 2 of the new one,
 * and an unplaced cursor is resolved against whatever the new query actually left standing.
 */
export const withFilter = (view: PickerView, filter: string): PickerView => ({
	...view,
	filter,
	cursor: null,
	refusal: null,
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
	const filter = record.filter;
	return {
		cursor,
		refusal: isPickerRefusal(refusal) ? refusal : null,
		previous: typeof previous === "string" ? previous : null,
		filter: typeof filter === "string" ? filter : null,
	};
};

const clamp = (cursor: number, length: number): number => {
	if (length === 0) return 0;
	if (!Number.isInteger(cursor) || cursor < 0) return 0;
	return cursor > length - 1 ? length - 1 : cursor;
};

/**
 * The rows this view actually offers. Every read below goes through it and so does the frame, which
 * is what stops the highlight, the announcement and the intent `<enter>` runs from addressing three
 * different lists once a filter is on.
 */
export const visibleFor = (entries: PickerEntries, view: PickerView): PickerEntries =>
	visibleEntries(entries, view.filter);

/**
 * Where the highlight actually sits. An unplaced cursor lands on the row of the process this window
 * was showing, so `<c-b> w` mounts the picker pointing at where Escape would take the operator
 * back; a `previous` no row offers — the process exited while the picker was up — falls back to the
 * first row rather than to nothing.
 */
export const cursorOf = (entries: PickerEntries, view: PickerView): number => {
	const rows = flatten(visibleFor(entries, view));
	if (view.cursor !== null) return clamp(view.cursor, rows.length);
	if (view.previous === null) return 0;
	const at = rows.findIndex(
		(row) => row._tag === "Process" && String(row.processId) === view.previous,
	);
	return at === -1 ? 0 : at;
};

/** The row the cursor names, or `null` when there is nothing to name. */
export const highlighted = (entries: PickerEntries, view: PickerView): PickerEntry | null =>
	flatten(visibleFor(entries, view))[cursorOf(entries, view)] ?? null;

/**
 * What one key did. `Moved` and `Cleared` carry the view to store, and so does `Filtering` — a
 * separate arm because it is the one answer that also moves DOM focus, into and out of the filter
 * input, which the surface cannot read off a `Moved`. `Chose` carries the intent to run; `Ignored`
 * says this key was never the picker's, so the surface may pass it on.
 */
export type PickerKeyAnswer =
	| {readonly _tag: "Moved"; readonly view: PickerView}
	| {readonly _tag: "Cleared"; readonly view: PickerView}
	| {readonly _tag: "Filtering"; readonly view: PickerView}
	| {readonly _tag: "Chose"; readonly intent: PickerIntent}
	/**
	 * Remove the highlighted row's process — forget it durably and stop it (#9447). It carries no
	 * view, because nothing about the picker changes: the row leaves the list when the process leaves
	 * the table, and a refused removal comes back as a `window.setView` the kernel handler sends
	 * (`./remove.ts`). A separate arm from `Chose` because a removal is not an intent: it binds no
	 * window and spawns nothing.
	 *
	 * The one arm no pointer gesture produces, which is the direction
	 * [ADR 0368](../../../../../.decisions/0368-picker-one-cursor-both-inputs.md) leaves open: its
	 * rule is that the pointer can express nothing the keyboard cannot, and a `role="option"` has no
	 * destructive gesture to spend here.
	 */
	| {readonly _tag: "Removing"; readonly processId: ProcessId}
	| {readonly _tag: "Ignored"};

const ignored: PickerKeyAnswer = {_tag: "Ignored"};

const DOWN = ["<arrowdown>", "j", "<c-n>", "<tab>"];
const UP = ["<arrowup>", "k", "<c-p>", "<s-tab>"];
const FIRST = ["<home>", "g"];
const LAST = ["<end>", "G"];
const CHOOSE = ["<enter>", "<space>"];
const DISMISS = ["<escape>"];
const FILTER = ["/"];

/**
 * The keys a feature flag adds, declared in their own list the way `../commands/table.ts` declares
 * `boardCommands` and `../keys/table.ts` declares `boardBindings`: with `processRemove` off the set
 * is empty, so `d` falls through to `ignored` exactly as it did before this key existed (#9447).
 *
 * `d` and never `x`: `../keys/table.ts` binds prefix `x` to `window:close`, which is why the epic's
 * no-gos rule an `x` shortcut out. It is live only while the filter is not focused — every key typed
 * into the filter is the input's own (`../ui/PickerView.tsx`), which is already how `j`/`k`/`g`/`G`
 * behave.
 */
const REMOVE = ["d"];

/** The flags a picker key can be gated on — the picker's own read of `../../features.ts`. */
export interface PickerKeyFeatures {
	readonly processRemove: boolean;
}

/** Every flag off: what a caller that has resolved none is entitled to, and `pickerKey`'s default. */
export const noPickerKeyFeatures: PickerKeyFeatures = {processRemove: false};

/** The keys these flags leave standing, empty for every flag that is off. */
const removeKeysFor = (features: PickerKeyFeatures): ReadonlyArray<string> =>
	features.processRemove ? REMOVE : [];

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
 * Escape is three keys in one, and the order is what makes all three reachable: a refusal showing
 * is cleared first, then an open filter is closed, and only a picker with neither goes back to
 * `previous`. A `previous` whose process has since stopped still chooses — `runPickerIntent`'s
 * attach arm (`./open.ts`) answers a missing row with a `ProcessGone` refusal shown in the window,
 * which is the one place the process table can be read.
 *
 * `/` opens the filter and nothing else takes text (founder ruling, 2026-09-09 on #8450), which is
 * what keeps `j` / `k` / `g` / `G` movement keys. Every key typed *into* the filter is the input's
 * own: the desk leaves a focused text entry its presses, so nothing below ever sees them — which is
 * also the whole of why `d` is not live there.
 *
 * `d` is the one key a flag decides, and it is read last: every key above it is the picker's
 * whatever the operator's `processRemove` is, so turning the flag on takes nothing away.
 */
export const pickerKey = (
	windowId: WindowId,
	entries: PickerEntries,
	view: PickerView,
	key: string,
	features: PickerKeyFeatures = noPickerKeyFeatures,
): PickerKeyAnswer => {
	const spelled = normalize(key);
	if (Result.isFailure(spelled)) return ignored;
	const pressed = spelled.success;
	const rows = flatten(visibleFor(entries, view));
	const at = cursorOf(entries, view);

	const moveTo = (next: number): PickerKeyAnswer => movedTo(view, at, next, rows.length);

	if (DOWN.includes(pressed)) return moveTo(clamp(at + 1, rows.length));
	if (UP.includes(pressed)) return moveTo(clamp(at - 1, rows.length));
	if (FIRST.includes(pressed)) return moveTo(0);
	if (LAST.includes(pressed)) return moveTo(clamp(rows.length - 1, rows.length));
	if (FILTER.includes(pressed)) {
		return view.filter === null
			? {_tag: "Filtering", view: {...view, filter: "", refusal: null}}
			: ignored;
	}
	if (DISMISS.includes(pressed)) {
		if (view.refusal !== null) {
			return {_tag: "Cleared", view: {...view, cursor: at, refusal: null}};
		}
		if (view.filter !== null) {
			// The cursor is written down as the filtered list left it, then the filter is dropped: the
			// row the operator was looking at keeps the highlight instead of the widened list's Nth.
			const row = rows[at];
			const widened = row === undefined ? -1 : flatten(entries).indexOf(row);
			return {
				_tag: "Filtering",
				view: {...view, cursor: widened === -1 ? 0 : widened, filter: null},
			};
		}
		return view.previous === null
			? ignored
			: {_tag: "Chose", intent: attachProcess(windowId, ProcessId.make(view.previous))};
	}
	if (CHOOSE.includes(pressed)) {
		const entry = rows[at];
		return entry === undefined ? ignored : {_tag: "Chose", intent: intentOf(windowId, entry)};
	}
	if (removeKeysFor(features).includes(pressed)) {
		// A program row names no process, so there is nothing to forget: the key is ignored rather
		// than answered with a refusal, because the operator asked about a row that cannot be removed
		// and never about a removal that failed.
		const entry = rows[at];
		return entry === undefined || entry._tag !== "Process"
			? ignored
			: {_tag: "Removing", processId: entry.processId};
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
	const rows = flatten(visibleFor(entries, view));
	const entry = rows[index];
	if (entry === undefined) return ignored;
	return gesture === "click"
		? {_tag: "Chose", intent: intentOf(windowId, entry)}
		: movedTo(view, cursorOf(entries, view), index, rows.length);
};
