/**
 * What an empty window offers: the programs it can spawn, and the processes it can attach to. Both
 * lists are read fresh from the registry (#7511) and the process-table port (#7516) every mount —
 * this slice stores neither, which is why nothing here is a service, a ref or a cache.
 *
 * A row with no renderer is left out of both lists. The founder's ruling on this ticket makes the
 * renderer optional and a row without one headless: it runs and exposes ports, and it cannot bind a
 * window, so offering it in a picker would offer a choice that resolves to a blank pane.
 */

import type {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {
	type AnyProgram,
	type ProgramId,
	programLabel,
	type RendererRef,
} from "@kampus/tuval-sdk/kernel/registry/program";
import {Registry} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {Effect} from "effect";
import type {ProjectLabel} from "../../projects/labels.ts";
import {ProcessTablePort} from "../../table/ProcessTablePort.ts";
import type {TableRow} from "../../table/row.ts";
import {HOME_PLACE, placeName, type SessionPlace} from "./place.ts";

/**
 * A program the picker can spawn. `label` is the row's own, defaulted from its identity.
 *
 * `place` is present on a row that takes its folder at start, and names the folder this entry opens
 * it in: such a row is offered once per open project, or once for home (#9694). Its label then
 * reads `<row> · <place>`. Absent, the row keeps its own folder rule and is offered once.
 */
export interface ProgramEntry {
	readonly _tag: "Program";
	readonly programId: ProgramId;
	readonly label: string;
	readonly place?: SessionPlace;
}

/** A live process the picker can attach the window to. `parentId` is `null` for a root process. */
export interface ProcessEntry {
	readonly _tag: "Process";
	readonly processId: ProcessId;
	readonly programId: ProgramId;
	readonly label: string;
	readonly parentId: ProcessId | null;
}

export type PickerEntry = ProgramEntry | ProcessEntry;

export interface PickerEntries {
	readonly programs: ReadonlyArray<ProgramEntry>;
	readonly processes: ReadonlyArray<ProcessEntry>;
}

export const noEntries: PickerEntries = {programs: [], processes: []};

/**
 * Can this row show in a window at all? The whole headless test, in one place. A type predicate, so
 * a caller that filters with it holds rows whose `renderer` is present to the checker too — the
 * transport's catalog builds a wire program off exactly that (`../transport/server.ts`).
 */
export const showsInAWindow = (row: AnyProgram): row is WindowedProgram =>
	row.renderer !== undefined;

/** A registry row that declares a renderer: what `showsInAWindow` admits. */
export type WindowedProgram = AnyProgram & {readonly renderer: RendererRef};

/**
 * A windowed program as the picker needs it, whichever side read it: the kernel off a registry row,
 * the page off the catalog frame (`../../page/AttachedDesk.tsx`).
 */
export interface OfferedProgram {
	readonly programId: ProgramId;
	readonly label: string;
	/** `Program.folderAtStart`: the row takes its folder when a process of it starts. */
	readonly folderAtStart: boolean;
}

export const offeredOf = (row: WindowedProgram): OfferedProgram => ({
	programId: row.id,
	label: programLabel(row),
	folderAtStart: row.folderAtStart === true,
});

/** The places a session row is offered in: each open project in the order it opened, else home. */
const placesOf = (projects: ReadonlyArray<ProjectLabel>): ReadonlyArray<SessionPlace> =>
	projects.length === 0
		? [HOME_PLACE]
		: projects.map(({key, label}) => ({_tag: "Project", key, label}));

/**
 * The program entries for these programs and these open projects (#9694, ruling #9668 R6.3). A row
 * that takes its folder at start is offered once per place, grouped by place so one project's
 * sessions sit together, and those groups come first, because a session is what a person opens a
 * window for most. Every other row follows, once each, in registration order.
 */
export const offerEntries = (
	programs: ReadonlyArray<OfferedProgram>,
	projects: ReadonlyArray<ProjectLabel>,
): ReadonlyArray<ProgramEntry> => {
	const sessions = programs.filter((program) => program.folderAtStart);
	const placed = placesOf(projects).flatMap((place) =>
		sessions.map(
			(program): ProgramEntry => ({
				_tag: "Program",
				programId: program.programId,
				label: `${program.label} · ${placeName(place)}`,
				place,
			}),
		),
	);
	const plain = programs
		.filter((program) => !program.folderAtStart)
		.map(
			(program): ProgramEntry => ({
				_tag: "Program",
				programId: program.programId,
				label: program.label,
			}),
		);
	return [...placed, ...plain];
};

/** The program entries a registry offers, with `projects` open. */
export const programEntries = (
	rows: ReadonlyArray<AnyProgram>,
	projects: ReadonlyArray<ProjectLabel> = [],
): ReadonlyArray<ProgramEntry> =>
	offerEntries(rows.filter(showsInAWindow).map(offeredOf), projects);

export const processEntries = (
	rows: ReadonlyArray<AnyProgram>,
	table: ReadonlyArray<TableRow>,
): ReadonlyArray<ProcessEntry> => {
	const showable = new Map(rows.filter(showsInAWindow).map((row) => [row.id, programLabel(row)]));
	const entries: Array<ProcessEntry> = [];
	for (const row of table) {
		const label = showable.get(row.programId);
		if (label === undefined) continue;
		entries.push({
			_tag: "Process",
			processId: row.id,
			programId: row.programId,
			label,
			parentId: row.parentId._tag === "Some" ? row.parentId.value : null,
		});
	}
	return entries;
};

/**
 * The two lists as one mount reads them. Never fails: an empty picker is a picker with nothing to
 * offer. It reads no open projects, so a session row reads as home here; the page's picker gets
 * the per-project list from the projects frame instead (`../../page/AttachedDesk.tsx`).
 */
export const readEntries: Effect.Effect<PickerEntries, never, Registry | ProcessTablePort> =
	Effect.gen(function* () {
		const registry = yield* Registry;
		const port = yield* ProcessTablePort;
		const rows = yield* registry.list;
		const table = yield* port.rows;
		return {programs: programEntries(rows), processes: processEntries(rows, table)};
	});

/**
 * The group an entry is listed under, as a key: one per place a session is offered in, one for the
 * other programs, one for the running processes. Entries of one group are always adjacent in
 * `flatten`'s order, which the filter keeps (`./filter.ts`) and the frame and the page keys read.
 */
export const groupKeyOf = (entry: PickerEntry): string => {
	if (entry._tag === "Process") return "processes";
	if (entry.place === undefined) return "programs";
	return entry.place._tag === "Home" ? "place:home" : `place:${entry.place.key}`;
};

/**
 * The entries as one indexable list — programs first, then processes. Every index the view holds
 * addresses this list, so the two sections and the cursor can never disagree about an order.
 */
export const flatten = (entries: PickerEntries): ReadonlyArray<PickerEntry> => [
	...entries.programs,
	...entries.processes,
];
