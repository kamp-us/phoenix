/**
 * What an empty window offers: the programs it can spawn, and the processes it can attach to. Both
 * lists are read fresh from the registry (#7511) and the process-table port (#7516) every mount —
 * this slice stores neither, which is why nothing here is a service, a ref or a cache.
 *
 * A row with no renderer is left out of both lists. The founder's ruling on this ticket makes the
 * renderer optional and a row without one headless: it runs and exposes ports, and it cannot bind a
 * window, so offering it in a picker would offer a choice that resolves to a blank pane.
 */

import {Effect} from "effect";
import type {ProcessId} from "../../process/process.ts";
import {type AnyProgram, type ProgramId, programLabel} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {ProcessTablePort} from "../../table/ProcessTablePort.ts";
import type {TableRow} from "../../table/row.ts";

/** A program the picker can spawn. `label` is the row's own, defaulted from its identity. */
export interface ProgramEntry {
	readonly _tag: "Program";
	readonly programId: ProgramId;
	readonly label: string;
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

/** Can this row show in a window at all? The whole headless test, in one place. */
export const showsInAWindow = (row: AnyProgram): boolean => row.renderer !== undefined;

export const programEntries = (rows: ReadonlyArray<AnyProgram>): ReadonlyArray<ProgramEntry> =>
	rows.filter(showsInAWindow).map((row) => ({
		_tag: "Program",
		programId: row.id,
		label: programLabel(row),
	}));

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

/** The two lists as one mount reads them. Never fails: an empty picker is a picker with nothing to offer. */
export const readEntries: Effect.Effect<PickerEntries, never, Registry | ProcessTablePort> =
	Effect.gen(function* () {
		const registry = yield* Registry;
		const port = yield* ProcessTablePort;
		const rows = yield* registry.list;
		const table = yield* port.rows;
		return {programs: programEntries(rows), processes: processEntries(rows, table)};
	});

/**
 * The entries as one indexable list — programs first, then processes. Every index the view holds
 * addresses this list, so the two sections and the cursor can never disagree about an order.
 */
export const flatten = (entries: PickerEntries): ReadonlyArray<PickerEntry> => [
	...entries.programs,
	...entries.processes,
];
