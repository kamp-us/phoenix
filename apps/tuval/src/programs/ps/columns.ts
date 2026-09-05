/**
 * The six columns of the `ps` table, declared once: the header a reader sees, the text a cell
 * shows, and the key the column sorts on.
 *
 * One declaration is the whole point. A header, a cell and a comparator written in three places
 * drift into a table that sorts by something other than what it shows, and a sortable table that
 * lies about its own order is worse than an unsorted one. Every consumer — the renderer, the sort,
 * the tests — reads this list.
 *
 * The kernel's row is program-blind (`../../table/row.ts`), so nothing here asks what program a
 * process runs: `programId` is a string in a cell like any other.
 */

import {Option} from "effect";
import type {PortDeclaration, TableRow} from "../../table/row.ts";

export type PsColumnId = "process" | "program" | "parent" | "ports" | "lifecycle" | "revision";

/**
 * What a column sorts on. A string compares by `localeCompare` and a number numerically, so the
 * revision column orders 2 before 10 rather than lexically.
 */
export type SortKey = string | number;

export interface PsColumn {
	readonly id: PsColumnId;
	/** The `<th>`'s text. English, like every identifier and heading in this repo. */
	readonly header: string;
	readonly cell: (row: TableRow) => string;
	readonly sortKey: (row: TableRow) => SortKey;
}

/** The em dash is the empty cell everywhere in this table: a root has no parent, not a blank. */
export const NO_PARENT = "—";

/**
 * The port summary: how many ports the process declares, then the distinct kinds behind them. The
 * kinds are sorted so one process's summary reads the same on every render, and the count leads
 * because it is what the column sorts on.
 */
export const portSummary = (ports: Readonly<Record<string, PortDeclaration>>): string => {
	const declarations = Object.values(ports);
	if (declarations.length === 0) return "0";
	const kinds = [...new Set(declarations.map((port) => port.kind))].sort((left, right) =>
		left.localeCompare(right),
	);
	return `${declarations.length} (${kinds.join(", ")})`;
};

const parentText = (row: TableRow): string =>
	Option.match(row.parentId, {onNone: () => NO_PARENT, onSome: (id) => String(id)});

/**
 * Every column by id. A `Record` keyed on the union rather than a list plus a lookup that can miss:
 * a new `PsColumnId` is a compile error here, and `psColumn` needs no absent arm.
 */
const columns: Readonly<Record<PsColumnId, PsColumn>> = {
	process: {
		id: "process",
		header: "Process",
		cell: (row) => String(row.id),
		sortKey: (row) => String(row.id),
	},
	program: {
		id: "program",
		header: "Program",
		cell: (row) => String(row.programId),
		sortKey: (row) => String(row.programId),
	},
	parent: {
		id: "parent",
		header: "Parent",
		cell: parentText,
		// A root sorts as the empty string, so every root groups at one end rather than under the dash.
		sortKey: (row) => Option.getOrElse(Option.map(row.parentId, String), () => ""),
	},
	ports: {
		id: "ports",
		header: "Ports",
		cell: (row) => portSummary(row.ports),
		sortKey: (row) => Object.keys(row.ports).length,
	},
	lifecycle: {
		id: "lifecycle",
		header: "Lifecycle",
		cell: (row) => row.stateSummary.lifecycle,
		sortKey: (row) => row.stateSummary.lifecycle,
	},
	revision: {
		id: "revision",
		header: "Revision",
		cell: (row) => String(row.stateSummary.revision),
		sortKey: (row) => row.stateSummary.revision,
	},
};

/** Left to right, as the table renders them. The issue's column order, and the default sort's tail. */
export const psColumnOrder: ReadonlyArray<PsColumnId> = [
	"process",
	"program",
	"parent",
	"ports",
	"lifecycle",
	"revision",
];

/** The column an id names. Total by construction: `columns` is keyed on the whole union. */
export const psColumn = (id: PsColumnId): PsColumn => columns[id];

/** Every column in render order. */
export const psColumns: ReadonlyArray<PsColumn> = psColumnOrder.map(psColumn);
