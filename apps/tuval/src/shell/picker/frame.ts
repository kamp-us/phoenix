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
import {cursorOf, type PickerView} from "./view.ts";

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
 * `status` does not, because it is only ever the count.
 */
export type PickerAnnouncement =
	| {readonly role: "status"; readonly live: "polite"; readonly text: string}
	| {readonly role: "alert"; readonly live: "assertive"; readonly text: string};

export interface PickerFrame {
	readonly role: "listbox";
	readonly id: string;
	readonly label: string;
	readonly windowId: WindowId;
	readonly activeDescendant: string | null;
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
	{keys: "↑ ↓ / k j", action: "Move between rows"},
	{keys: "Home / End", action: "Jump to the first or last row"},
	{keys: "Enter", action: "Open or attach the highlighted row"},
	{keys: "Escape", action: "Dismiss the message"},
] as const;

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
	const rows = flatten(entries);
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
				entry,
			};
		});

	const groups: ReadonlyArray<PickerGroup> = [
		{
			role: "group",
			id: `picker-${windowId}-programs`,
			label: "Programs",
			options: optionsFrom(entries.programs, 0),
			emptyMessage:
				entries.programs.length === 0 ? "No registered program can fill a window." : null,
		},
		{
			role: "group",
			id: `picker-${windowId}-processes`,
			label: "Running processes",
			options: optionsFrom(entries.processes, entries.programs.length),
			emptyMessage: entries.processes.length === 0 ? "Nothing is running to attach to." : null,
		},
	];

	const announcement: PickerAnnouncement =
		view.refusal === null
			? {
					role: "status",
					live: "polite",
					text: `${entries.programs.length} program${entries.programs.length === 1 ? "" : "s"}, ${
						entries.processes.length
					} running process${entries.processes.length === 1 ? "" : "es"}.`,
				}
			: {role: "alert", live: "assertive", text: refusalMessage(view.refusal)};

	return {
		role: "listbox",
		id: `picker-${windowId}`,
		label: "Open a program or attach a running process",
		windowId,
		activeDescendant: rows.length === 0 ? null : optionId(at),
		groups,
		announcement,
		theme: themeFor(options),
		keyHelp: [...KEY_HELP],
	};
};
