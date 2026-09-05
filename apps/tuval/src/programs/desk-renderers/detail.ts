/**
 * What the desk inspector shows about one process, as data.
 *
 * `engine-view` and `ps` both declare an inspector renderer (#7500 rulings 4 and 6), and both are
 * looking at the same process table — founder ruling 2 gives them one `Snapshot.processes` and no
 * port of their own. So the facts are derived once, here, and the two programs differ only in where
 * they read their selection from. That is what makes "both inspectors show the same thing" a
 * property of the code rather than a thing to keep checking by eye.
 *
 * Every arm is a value. A selection naming a process that has left the table is `SelectionGone` and
 * not a throw, because the table moves under a selection all the time — a stopped process is
 * ordinary, and an inspector that crashed on one would take the desk region down with it.
 */

import type {ProcessId, ProgramId} from "../../protocol/ids.ts";
import type {ProcessRow} from "../../protocol/process-row.ts";

/** One declared port, flattened for display: its name, its kind and which way it points. */
export interface PortLine {
	readonly name: string;
	readonly kind: string;
	readonly direction: "in" | "out";
}

/** The facts about a selected process. Every field the issue names, and nothing program-specific. */
export interface ProcessFacts {
	readonly _tag: "Facts";
	readonly processId: ProcessId;
	readonly programId: ProgramId;
	/** `null` is a root process, which is a fact and not a missing value. */
	readonly parentId: ProcessId | null;
	/** Sorted by name, so one process reads the same on every render. */
	readonly ports: ReadonlyArray<PortLine>;
	readonly lifecycle: "running" | "stopping";
	readonly revision: number;
}

/** Nothing is selected. Named, because a region with no content still says which nothing it is. */
export interface NoSelection {
	readonly _tag: "NoSelection";
}

/** A selection the table no longer holds: the process was there and has left. */
export interface SelectionGone {
	readonly _tag: "SelectionGone";
	readonly processId: ProcessId;
}

export type ProcessDetail = ProcessFacts | NoSelection | SelectionGone;

export const noSelection: NoSelection = {_tag: "NoSelection"};

const portLines = (ports: ProcessRow["ports"]): ReadonlyArray<PortLine> =>
	Object.entries(ports)
		.map(([name, port]) => ({name, kind: port.kind, direction: port.direction}))
		.sort((left, right) => left.name.localeCompare(right.name));

/**
 * The selected process's detail, out of the snapshot's rows and a selected id. Pure and total: no
 * row list and no id can make it fail, so the caller has nothing to catch and nothing to default.
 */
export const processDetail = (
	processes: ReadonlyArray<ProcessRow>,
	selected: ProcessId | null,
): ProcessDetail => {
	if (selected === null) return noSelection;
	const row = processes.find((process) => process.id === selected);
	if (row === undefined) return {_tag: "SelectionGone", processId: selected};
	return {
		_tag: "Facts",
		processId: row.id,
		programId: row.programId,
		parentId: row.parentId,
		ports: portLines(row.ports),
		lifecycle: row.stateSummary.lifecycle,
		revision: row.stateSummary.revision,
	};
};
