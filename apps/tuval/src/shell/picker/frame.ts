/**
 * What the picker renders, as data: an ARIA listbox with one group per section, an accessible name
 * on every option, the active option named by id, and a live region for the refusal. The browser
 * page (#7560) binds this to elements verbatim — it decides nothing, which is how the keyboard and
 * screen-reader behaviour stays testable here, in a unit test with no DOM.
 *
 * Colour is named by role token, never by value (`design-system-manifest.md`, "reach for the role
 * layer only"): a frame says `--surface`, and the surface that paints it resolves the scale. Two of
 * that manifest's Pillar-4 prohibitions are why an option carries `marker` and `selected` beside
 * its name and why `motion` exists — no state may be signalled by colour alone or by motion alone.
 */

import type {ProcessId} from "../../process/process.ts";
import type {WindowId} from "../window/host.ts";
import {flatten, type PickerEntries, type PickerEntry} from "./entries.ts";
import {refusalMessage} from "./refusal.ts";
import {cursorOf, type PickerView, visibleFor} from "./view.ts";

/**
 * The role tokens the picker paints in, by name. Dark is the only scheme the shell has: Tuval is a
 * terminal-shaped surface and its window chrome is dark at rest, so a frame states `dark` rather
 * than inheriting whatever the page happened to set.
 */
export interface PickerTheme {
	readonly scheme: "dark";
	/** `none` collapses every transition to an instant swap — the `prefers-reduced-motion` answer. */
	readonly motion: "none" | "standard";
	readonly tokens: {
		readonly surface: string;
		readonly surfaceRaised: string;
		readonly border: string;
		readonly textPrimary: string;
		readonly textMuted: string;
		readonly accent: string;
		readonly focusRing: string;
	};
}

export interface PickerOption {
	readonly role: "option";
	/** The DOM id `aria-activedescendant` points at. Window-scoped, so two pickers never collide. */
	readonly id: string;
	/** The option's accessible name — what a screen reader announces, and all it announces. */
	readonly name: string;
	/** The second line: provenance a sighted reader scans. Already inside `name`, never only here. */
	readonly detail: string;
	readonly selected: boolean;
	/** The highlight as a character, so selection is never carried by colour alone. */
	readonly marker: string;
	/**
	 * This option's index into `flatten(entries)` — the argument `pickerPointer` takes, so a surface
	 * binding a pointer event reads the row number off the frame instead of re-deriving the offset
	 * its section starts at.
	 */
	readonly index: number;
	readonly entry: PickerEntry;
}

export interface PickerGroup {
	readonly role: "group";
	readonly id: string;
	readonly label: string;
	readonly options: ReadonlyArray<PickerOption>;
	/** Why this group is empty, for the reader who would otherwise wonder. `null` when it is not. */
	readonly emptyMessage: string | null;
}

/**
 * The refusal channel. An `alert` interrupts because the user just acted and nothing happened;
 * `status` does not, because it is only ever the count. That split is the whole of the rule that
 * the filter's count never reaches the assertive channel — an `alert` is a refusal and nothing else.
 */
export type PickerAnnouncement =
	| {
			readonly role: "status";
			readonly live: "polite";
			/** WCAG 2.2 SC 4.1.3: the count is read whole, never as the characters that changed. */
			readonly atomic: true;
			readonly text: string;
			/**
			 * The two region ids the surface writes into by turns, so a count that did not change is
			 * still announced (the GOV.UK status technique). `null` is one static region, which is what
			 * a picker nobody is filtering needs.
			 */
			readonly alternates: readonly [string, string] | null;
	  }
	| {readonly role: "alert"; readonly live: "assertive"; readonly text: string};

/**
 * The filter input at the top of the list, once `/` has opened it. `null` until then.
 *
 * It is a combobox and not a bare text field, because while it exists it is the element that holds
 * DOM focus — and `aria-activedescendant` is announced only off the focused element (#7499). So the
 * highlight moves with the combobox's own `aria-activedescendant`, `controls` names the listbox it
 * points into, and the listbox goes back to carrying it the moment Escape closes this.
 */
export interface PickerFilterFrame {
	readonly role: "combobox";
	readonly id: string;
	readonly label: string;
	readonly placeholder: string;
	readonly value: string;
	readonly expanded: true;
	readonly autocomplete: "list";
	/** The listbox this filter's highlight walks. */
	readonly controls: string;
	/** How many of the picker's rows this query left, and how many there were. */
	readonly matches: number;
	readonly total: number;
}

export interface PickerFrame {
	readonly role: "listbox";
	readonly id: string;
	readonly label: string;
	readonly windowId: WindowId;
	readonly activeDescendant: string | null;
	readonly filter: PickerFilterFrame | null;
	readonly groups: ReadonlyArray<PickerGroup>;
	readonly announcement: PickerAnnouncement;
	readonly theme: PickerTheme;
	/** The keys this frame answers to, as help text a surface may show and a test may read. */
	readonly keyHelp: ReadonlyArray<{readonly keys: string; readonly action: string}>;
}

export interface PickerFrameOptions {
	/** The user's `prefers-reduced-motion`. Unknown is `true`: the safe answer is the still one. */
	readonly reducedMotion?: boolean;
}

const themeFor = (options: PickerFrameOptions | undefined): PickerTheme => ({
	scheme: "dark",
	motion: options?.reducedMotion === false ? "standard" : "none",
	tokens: {
		surface: "--surface",
		surfaceRaised: "--surface-raised",
		border: "--border",
		textPrimary: "--text-primary",
		textMuted: "--text-muted",
		accent: "--accent",
		focusRing: "--focus-ring",
	},
});

const shortId = (id: ProcessId): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

const nameOf = (entry: PickerEntry): string =>
	entry._tag === "Program"
		? `${entry.label} — program ${entry.programId}`
		: `${entry.label} — process ${shortId(entry.processId)}, ${
				entry.parentId === null ? "no parent" : `child of ${shortId(entry.parentId)}`
			}`;

const detailOf = (entry: PickerEntry): string =>
	entry._tag === "Program"
		? entry.programId
		: `${entry.processId}${entry.parentId === null ? "" : ` ← ${entry.parentId}`}`;

const KEY_HELP = [
	{keys: "↑ ↓ or k j", action: "Move between rows"},
	{keys: "Home / End", action: "Jump to the first or last row"},
	{keys: "/", action: "Filter the rows by typing"},
	{keys: "Enter", action: "Open or attach the highlighted row"},
] as const;

/** Escape's help is the one row that reads off the view: it says what the key will actually do. */
const escapeHelp = (view: PickerView) => ({
	keys: "Escape",
	action:
		view.filter !== null
			? "Close the filter and show every row"
			: view.previous === null
				? "Dismiss the message"
				: "Return to the process this window was showing",
});

/**
 * The frame for one mount. Pure over `entries` and `view`: the same pair always renders the same
 * frame, which is what lets a test assert the announced name of the active option.
 */
export const pickerFrame = (
	windowId: WindowId,
	entries: PickerEntries,
	view: PickerView,
	options?: PickerFrameOptions,
): PickerFrame => {
	const visible = visibleFor(entries, view);
	const rows = flatten(visible);
	const at = cursorOf(entries, view);
	const optionId = (index: number) => `picker-${windowId}-option-${index}`;

	const optionsFrom = (section: ReadonlyArray<PickerEntry>, offset: number) =>
		section.map((entry, index): PickerOption => {
			const absolute = offset + index;
			const selected = rows.length > 0 && absolute === at;
			return {
				role: "option",
				id: optionId(absolute),
				name: nameOf(entry),
				detail: detailOf(entry),
				selected,
				marker: selected ? "▸" : " ",
				index: absolute,
				entry,
			};
		});

	const filtering = view.filter !== null;
	const groups: ReadonlyArray<PickerGroup> = [
		{
			role: "group",
			id: `picker-${windowId}-programs`,
			label: "Programs",
			options: optionsFrom(visible.programs, 0),
			emptyMessage:
				visible.programs.length > 0
					? null
					: filtering
						? "No program matches this filter."
						: "No registered program can fill a window.",
		},
		{
			role: "group",
			id: `picker-${windowId}-processes`,
			label: "Running processes",
			options: optionsFrom(visible.processes, visible.programs.length),
			emptyMessage:
				visible.processes.length > 0
					? null
					: filtering
						? "No running process matches this filter."
						: "Nothing is running to attach to.",
		},
	];

	const total = flatten(entries).length;
	const counts = `${entries.programs.length} program${
		entries.programs.length === 1 ? "" : "s"
	}, ${entries.processes.length} running process${entries.processes.length === 1 ? "" : "es"}.`;
	const matchCount =
		rows.length === 0 ? "No windows match this filter." : `${rows.length} of ${total} windows`;

	const announcement: PickerAnnouncement =
		view.refusal !== null
			? {role: "alert", live: "assertive", text: refusalMessage(view.refusal)}
			: {
					role: "status",
					live: "polite",
					atomic: true,
					text: filtering ? matchCount : counts,
					alternates: filtering
						? [`picker-${windowId}-status-a`, `picker-${windowId}-status-b`]
						: null,
				};

	const filter: PickerFilterFrame | null =
		view.filter === null
			? null
			: {
					role: "combobox",
					id: `picker-${windowId}-filter`,
					label: "Filter rows by name",
					placeholder: "Type to narrow",
					value: view.filter,
					expanded: true,
					autocomplete: "list",
					controls: `picker-${windowId}`,
					matches: rows.length,
					total,
				};

	return {
		role: "listbox",
		id: `picker-${windowId}`,
		label: "Open a program or attach a running process",
		windowId,
		activeDescendant: rows.length === 0 ? null : optionId(at),
		filter,
		groups,
		announcement,
		theme: themeFor(options),
		keyHelp: [...KEY_HELP, escapeHelp(view)],
	};
};
