/**
 * The picker's "Open project…" (#9697, ruling #9668 R6.1): recent projects first, most recent first,
 * then a way into a folder browser. Choosing a folder opens it through the kernel's `project open`,
 * which is the request `tuval open` sends and which asks "Trust this folder?" on a first open.
 *
 * It is two steps of the one picker, never a second surface: the step lives in the window's view
 * slot beside the cursor, refusal and filter (`./view.ts`), so the listbox that holds focus keeps it
 * from the program list into each step and back, and the same keys move the same highlight. What a
 * step lists is not in the slot. The recent folders and a folder's subfolders are read from the
 * kernel as the step is shown (`./project-opener.ts`), and this module turns whatever has been read
 * so far into rows, keys and a frame, pure, like `./view.ts` and `./frame.ts` do for the program
 * list.
 *
 * Moving into a folder is the one choice that reads before it moves: the surface lists the folder
 * first and only then shows it, so a folder that cannot be read leaves the browser where it was, with
 * the refusal, instead of on an empty step with nowhere to go.
 */

import type {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/host";
import {normalize} from "@kampus/tuval-ui/keys";
import {Result} from "effect";
import type {
	BrowsedFolder,
	FolderListing,
	RecentProjectRow,
} from "../../projects/open-project-wire.ts";
import {clamp, groupJump} from "./cursor.ts";
import {narrowRows} from "./filter.ts";
import {
	type PickerAnnouncement,
	type PickerFilterFrame,
	type PickerFrame,
	type PickerFrameOptions,
	type PickerGroup,
	type PickerOption,
	pickerTheme,
} from "./frame.ts";
import {browseStep, LAST_ROW, type OpenProjectStep, RECENT_STEP} from "./open-project-step.ts";
import {refusalMessage} from "./refusal.ts";
import type {PickerView} from "./view.ts";

/** One step as a key, so what was read for it is kept against the step it was read for. */
export const stepKey = (step: OpenProjectStep): string =>
	step._tag === "Recent" ? "recent" : `browse:${step.folder ?? ""}`;

/** What the surface has read from the kernel for the step it shows. */
export type StepData =
	| {readonly _tag: "Loading"}
	| {readonly _tag: "Unreadable"; readonly reason: string}
	| {readonly _tag: "Recent"; readonly projects: ReadonlyArray<RecentProjectRow>}
	| {readonly _tag: "Folder"; readonly listing: FolderListing};

export const LOADING: StepData = {_tag: "Loading"};

export type OpenProjectRow =
	| {readonly _tag: "Recent"; readonly label: string; readonly project: RecentProjectRow}
	| {readonly _tag: "BrowseFolders"; readonly label: string}
	| {readonly _tag: "OpenHere"; readonly label: string; readonly listing: FolderListing}
	| {readonly _tag: "Up"; readonly label: string; readonly folder: string; readonly name: string}
	| {readonly _tag: "Folder"; readonly label: string; readonly folder: BrowsedFolder};

const BROWSE_ROW: OpenProjectRow = {_tag: "BrowseFolders", label: "Browse for a folder…"};

/** The rows `step` offers over `data`. Data read for any other step is read as nothing yet. */
export const stepRows = (step: OpenProjectStep, data: StepData): ReadonlyArray<OpenProjectRow> => {
	if (step._tag === "Recent") {
		const recent =
			data._tag === "Recent"
				? data.projects.map(
						(project): OpenProjectRow => ({_tag: "Recent", label: project.name, project}),
					)
				: [];
		return [...recent, BROWSE_ROW];
	}
	if (data._tag !== "Folder") return [];
	const {listing} = data;
	return [
		{
			_tag: "OpenHere",
			label: listing.open ? `Go to ${listing.name}` : `Open ${listing.name}`,
			listing,
		},
		...(listing.parent === null
			? []
			: [
					{
						_tag: "Up",
						label: `Up to ${listing.parent.name}`,
						folder: listing.parent.folder,
						name: listing.parent.name,
					} satisfies OpenProjectRow,
				]),
		...listing.folders.map(
			(folder): OpenProjectRow => ({_tag: "Folder", label: folder.name, folder}),
		),
	];
};

type GroupKey = "recent" | "browse" | "here" | "folders";

const groupOf = (row: OpenProjectRow): GroupKey => {
	switch (row._tag) {
		case "Recent":
			return "recent";
		case "BrowseFolders":
			return "browse";
		case "OpenHere":
		case "Up":
			return "here";
		case "Folder":
			return "folders";
	}
};

/** The rows the view's filter leaves, each group in its place. */
export const visibleStepRows = (
	step: OpenProjectStep,
	data: StepData,
	view: PickerView,
): ReadonlyArray<OpenProjectRow> =>
	narrowRows(stepRows(step, data), view.filter, (row) => row.label, groupOf);

const cursorIn = (rows: ReadonlyArray<OpenProjectRow>, view: PickerView): number =>
	clamp(view.cursor ?? 0, rows.length);

/**
 * What one key or gesture did on a step. The three view arms are `PickerKeyAnswer`'s, stored the
 * same way. `Browse` asks to show a folder, read first; `Open` asks the kernel to open one; `Focus`
 * is a choice of a project already open, which lands the program list on it instead of opening it
 * twice.
 */
export type OpenProjectAnswer =
	| {readonly _tag: "Moved"; readonly view: PickerView}
	| {readonly _tag: "Cleared"; readonly view: PickerView}
	| {readonly _tag: "Filtering"; readonly view: PickerView}
	| {readonly _tag: "Browse"; readonly folder: string | null}
	| {readonly _tag: "Open"; readonly folder: string; readonly name: string}
	| {readonly _tag: "Focus"; readonly key: string; readonly name: string}
	| {readonly _tag: "Ignored"};

const ignored: OpenProjectAnswer = {_tag: "Ignored"};

const DOWN = ["<arrowdown>", "j", "<c-n>", "<tab>"];
const UP = ["<arrowup>", "k", "<c-p>", "<s-tab>"];
const NEXT_GROUP = ["<pagedown>"];
const PREVIOUS_GROUP = ["<pageup>"];
const FIRST = ["<home>", "g"];
const LAST = ["<end>", "G"];
const CHOOSE = ["<enter>", "<space>"];
const DISMISS = ["<escape>"];
const FILTER = ["/"];
/** The folder browser's own two keys: into the highlighted folder, and up out of this one. */
const INTO = ["<arrowright>", "l"];
const OUT = ["<arrowleft>", "h"];

/** What choosing `row` asks for. */
const choose = (row: OpenProjectRow): OpenProjectAnswer => {
	switch (row._tag) {
		case "Recent":
			return row.project.open
				? {_tag: "Focus", key: row.project.key, name: row.project.name}
				: {_tag: "Open", folder: row.project.folder, name: row.project.name};
		case "BrowseFolders":
			return {_tag: "Browse", folder: null};
		case "OpenHere":
			return row.listing.open
				? {_tag: "Focus", key: row.listing.key, name: row.listing.name}
				: {_tag: "Open", folder: row.listing.folder, name: row.listing.name};
		case "Up":
			return {_tag: "Browse", folder: row.folder};
		case "Folder":
			return {_tag: "Browse", folder: row.folder.folder};
	}
};

const moved = (view: PickerView, at: number, next: number): OpenProjectAnswer =>
	next === at
		? {_tag: "Moved", view: {...view, cursor: at}}
		: {_tag: "Moved", view: {...view, cursor: next, refusal: null}};

/**
 * One key against a step. Every key the program list answers means the same here (`./view.ts`);
 * the folder browser adds → and ← to go into the highlighted folder and up out of this one.
 *
 * Escape goes back one step at a time, each after a showing refusal and an open filter are cleared:
 * from the browser to the recent projects, landing on "Browse for a folder…", and from there to the
 * program list, landing on "Open project…".
 */
export const openProjectKey = (
	step: OpenProjectStep,
	data: StepData,
	view: PickerView,
	key: string,
): OpenProjectAnswer => {
	const spelled = normalize(key);
	if (Result.isFailure(spelled)) return ignored;
	const pressed = spelled.success;
	const rows = visibleStepRows(step, data, view);
	const at = cursorIn(rows, view);
	const row = rows[at];

	if (DOWN.includes(pressed)) return moved(view, at, clamp(at + 1, rows.length));
	if (UP.includes(pressed)) return moved(view, at, clamp(at - 1, rows.length));
	if (NEXT_GROUP.includes(pressed) || PREVIOUS_GROUP.includes(pressed)) {
		const direction = NEXT_GROUP.includes(pressed) ? "next" : "previous";
		return moved(view, at, groupJump(rows.map(groupOf), at, direction));
	}
	if (FIRST.includes(pressed)) return moved(view, at, 0);
	if (LAST.includes(pressed)) return moved(view, at, clamp(rows.length - 1, rows.length));
	if (FILTER.includes(pressed)) {
		return view.filter === null
			? {_tag: "Filtering", view: {...view, filter: "", cursor: null, refusal: null}}
			: ignored;
	}
	if (DISMISS.includes(pressed)) {
		if (view.refusal !== null) return {_tag: "Cleared", view: {...view, cursor: at, refusal: null}};
		if (view.filter !== null) {
			const widened = row === undefined ? -1 : stepRows(step, data).indexOf(row);
			return {
				_tag: "Filtering",
				view: {...view, filter: null, cursor: widened === -1 ? 0 : widened},
			};
		}
		return {
			_tag: "Moved",
			view:
				step._tag === "Browse"
					? {...view, step: RECENT_STEP, cursor: LAST_ROW}
					: {...view, step: null, cursor: LAST_ROW},
		};
	}
	if (CHOOSE.includes(pressed)) return row === undefined ? ignored : choose(row);
	if (step._tag === "Browse" && INTO.includes(pressed)) {
		return row?._tag === "Folder" || row?._tag === "Up" ? choose(row) : ignored;
	}
	if (step._tag === "Browse" && OUT.includes(pressed)) {
		const parent = data._tag === "Folder" ? data.listing.parent : null;
		return parent === null ? ignored : {_tag: "Browse", folder: parent.folder};
	}
	return ignored;
};

/** One pointer gesture on a step's row, answered in `openProjectKey`'s union (ADR 0368). */
export const openProjectPointer = (
	step: OpenProjectStep,
	data: StepData,
	view: PickerView,
	index: number,
	gesture: "hover" | "click",
): OpenProjectAnswer => {
	const rows = visibleStepRows(step, data, view);
	const row = rows[index];
	if (row === undefined) return ignored;
	return gesture === "click" ? choose(row) : moved(view, cursorIn(rows, view), index);
};

/**
 * The view a step leaves once a project is open, or once the one chosen turned out to be open
 * already: back on the program list, its highlight on that project's sessions (`./view.ts`).
 */
export const landedOn = (
	view: PickerView,
	key: string,
	label: string,
	how: "opened" | "already-open",
): PickerView => ({
	...view,
	step: null,
	cursor: null,
	filter: null,
	refusal: null,
	landing: {key, label, how},
});

/** The step `view` moves to once `folder`'s listing has been read: the browser, from its top. */
export const browsing = (view: PickerView, folder: string | null): PickerView => ({
	...view,
	step: browseStep(folder),
	cursor: null,
	filter: null,
	refusal: null,
});

/** The first step, as "Open project…" opens it. */
export const recentFrom = (view: PickerView): PickerView => ({
	...view,
	step: RECENT_STEP,
	cursor: null,
	filter: null,
	refusal: null,
	landing: null,
});

const plural = (count: number, one: string, many: string): string =>
	`${count} ${count === 1 ? one : many}`;

const nameOf = (row: OpenProjectRow): string => {
	switch (row._tag) {
		case "Recent":
			return `${row.project.name}${row.project.open ? ", open now" : ""} — ${row.project.folder}`;
		case "BrowseFolders":
			return `${row.label} — starting at your home folder`;
		case "OpenHere":
			return row.listing.open
				? `${row.label}, already open — ${row.listing.folder}`
				: `${row.label} as a project — ${row.listing.folder}`;
		case "Up":
			return `${row.label} — ${row.folder}`;
		case "Folder":
			return `${row.folder.name}${row.folder.open ? ", open now" : ""}${
				row.folder.hasConfig ? ", has a Tuval config" : ""
			}`;
	}
};

const detailOf = (row: OpenProjectRow): string => {
	switch (row._tag) {
		case "Recent":
			return row.project.open ? `Open now · ${row.project.folder}` : row.project.folder;
		case "BrowseFolders":
			return "Starts at your home folder";
		case "OpenHere":
			return row.listing.open ? "Already open in this desk" : "Opens this folder as a project";
		case "Up":
			return row.folder;
		case "Folder":
			return [row.folder.open ? "Open now" : null, row.folder.hasConfig ? "Tuval config" : null]
				.filter((part) => part !== null)
				.join(" · ");
	}
};

const RECENT_KEY_HELP = [
	{keys: "↑ ↓ or k j", action: "Move between rows"},
	{keys: "Page Up / Page Down", action: "Jump to the previous or next group"},
	{keys: "Home / End", action: "Jump to the first or last row"},
	{keys: "/", action: "Filter the rows by typing"},
	{keys: "Enter", action: "Open the highlighted project, go to it if it is open, or browse"},
] as const;

const BROWSE_KEY_HELP = [
	{keys: "↑ ↓ or k j", action: "Move between rows"},
	{keys: "Home / End", action: "Jump to the first or last row"},
	{keys: "→ or l", action: "Go into the highlighted folder"},
	{keys: "← or h", action: "Go up one folder"},
	{keys: "/", action: "Filter the rows by typing"},
	{keys: "Enter", action: "Go into the highlighted folder, or open this one"},
] as const;

const escapeHelp = (step: OpenProjectStep, view: PickerView) => ({
	keys: "Escape",
	action:
		view.refusal !== null
			? "Dismiss the message"
			: view.filter !== null
				? "Close the filter and show every row"
				: step._tag === "Browse"
					? "Back to recent projects"
					: "Back to the program list",
});

/** The project an open is waiting on, while it waits: the trust prompt may be asking about it. */
export interface Opening {
	readonly name: string;
}

const NOTHING_MATCHES = "Nothing matches this filter.";

export interface OpenProjectFrameOptions extends PickerFrameOptions {
	readonly opening?: Opening | null;
}

/**
 * The frame for one step, in the program list's own shape (`./frame.ts`), so one surface binds both
 * and a test reads the same roles, names and live region off either.
 */
export const openProjectFrame = (
	windowId: WindowId,
	step: OpenProjectStep,
	data: StepData,
	view: PickerView,
	options?: OpenProjectFrameOptions,
): PickerFrame<OpenProjectRow> => {
	const all = stepRows(step, data);
	const rows = visibleStepRows(step, data, view);
	const at = cursorIn(rows, view);
	const filtering = view.filter !== null;
	const optionId = (index: number) => `picker-${windowId}-open-project-option-${index}`;
	const optionsOf = (key: GroupKey): ReadonlyArray<PickerOption<OpenProjectRow>> =>
		rows.flatMap((row, index) =>
			groupOf(row) === key
				? [
						{
							role: "option",
							id: optionId(index),
							name: nameOf(row),
							detail: detailOf(row),
							selected: index === at,
							marker: index === at ? "▸" : " ",
							index,
							entry: row,
						},
					]
				: [],
		);
	const group = (
		key: GroupKey,
		label: string,
		empty: string | null,
		labelKind: "section" | "path" = "section",
	): PickerGroup<OpenProjectRow> => {
		const options = optionsOf(key);
		return {
			role: "group",
			labelKind,
			id: `picker-${windowId}-open-project-${key}`,
			label,
			options,
			emptyMessage: options.length > 0 ? null : empty,
		};
	};

	const listed: ReadonlyArray<PickerGroup<OpenProjectRow>> =
		step._tag === "Recent"
			? [
					group(
						"recent",
						"Recent projects",
						data._tag === "Unreadable"
							? `Could not read the recent projects: ${data.reason}`
							: data._tag === "Recent"
								? "No project has been opened yet."
								: "Reading the recent projects…",
					),
					group("browse", "Other folders", null),
				]
			: data._tag === "Folder"
				? [
						group("here", data.listing.folder, null, "path"),
						group(
							"folders",
							`Folders in ${data.listing.name}`,
							`No folders inside ${data.listing.name}.`,
						),
					]
				: [
						group(
							"folders",
							step.folder ?? "Your home folder",
							data._tag === "Unreadable"
								? `Could not read this folder: ${data.reason}`
								: "Reading the folders…",
							step.folder === null ? "section" : "path",
						),
					];
	// Under a filter an empty group is not news while another group still has a match, so the "nothing
	// matches" text belongs to the whole list: said once, on the first group, and only when no row is left.
	const groups = filtering
		? listed.map((group, index) => ({
				...group,
				emptyMessage: rows.length === 0 && index === 0 ? NOTHING_MATCHES : null,
			}))
		: listed;

	const opening = options?.opening ?? null;
	const settled =
		step._tag === "Recent"
			? data._tag === "Recent"
				? `Open project. ${plural(data.projects.length, "recent project", "recent projects")}, then Browse for a folder.`
				: "Open project. Reading the recent projects…"
			: data._tag === "Folder"
				? `${data.listing.folder}: ${plural(data.listing.folders.length, "folder", "folders")}.`
				: "Reading the folders…";
	const announcement: PickerAnnouncement =
		view.refusal !== null
			? {role: "alert", live: "assertive", text: refusalMessage(view.refusal)}
			: data._tag === "Unreadable"
				? {role: "alert", live: "assertive", text: `Could not read it: ${data.reason}`}
				: {
						role: "status",
						live: "polite",
						atomic: true,
						text:
							opening !== null
								? `Opening ${opening.name}… If the desk asks whether you trust this folder, answer there.`
								: filtering
									? rows.length === 0
										? NOTHING_MATCHES
										: `${rows.length} of ${all.length} rows`
									: settled,
						alternates:
							filtering && opening === null
								? [`picker-${windowId}-status-a`, `picker-${windowId}-status-b`]
								: null,
					};

	const filter: PickerFilterFrame | null =
		view.filter === null
			? null
			: {
					role: "combobox",
					id: `picker-${windowId}-filter`,
					label:
						step._tag === "Recent" ? "Filter recent projects by name" : "Filter folders by name",
					placeholder: "Type to narrow",
					value: view.filter,
					expanded: true,
					autocomplete: "list",
					controls: `picker-${windowId}`,
					matches: rows.length,
					total: all.length,
				};

	return {
		role: "listbox",
		id: `picker-${windowId}`,
		label:
			step._tag === "Recent"
				? "Open project: recent projects"
				: `Open project: folders in ${data._tag === "Folder" ? data.listing.folder : (step.folder ?? "your home folder")}`,
		windowId,
		activeDescendant: rows.length === 0 ? null : optionId(at),
		filter,
		groups,
		announcement,
		theme: pickerTheme(options),
		keyHelp: [
			...(step._tag === "Recent" ? RECENT_KEY_HELP : BROWSE_KEY_HELP),
			escapeHelp(step, view),
		],
	};
};
