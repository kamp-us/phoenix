/**
 * The table's order: the default one, and every sorted one derived from it.
 *
 * The default order is a depth-first walk of the process forest — a parent immediately before its
 * children, siblings by process id — so a live update that adds or removes a row moves that row and
 * leaves every other row where it was. A list rebuilt from `Snapshot.processes` in arrival order
 * would reshuffle under the kernel instead, and a table that reshuffles while a keyboard user is
 * walking it loses their place.
 *
 * Every sort is that order, re-sorted stably: equal keys keep the default order, in both
 * directions. `Array.prototype.sort` is specified stable (ECMA-262 §23.1.3.30, "SortIndexedProperties
 * … the sort is stable"), and the default order is applied first, so the tiebreak is the forest walk
 * rather than whatever order the kernel happened to send.
 */

import {Option} from "effect";
import type {ProcessId} from "../../protocol/ids.ts";
import type {TableRow} from "../../table/row.ts";
import {type PsColumnId, psColumn, type SortKey} from "./columns.ts";

export type SortDirection = "ascending" | "descending";

const byId = (left: TableRow, right: TableRow): number =>
	String(left.id).localeCompare(String(right.id));

/**
 * Parent before child, then process id. A row whose `parentId` names a process that is not in the
 * table is a root here: the parent has left, and hiding the child under an absent row would drop it
 * from the table entirely.
 *
 * The `seen` set is not defensive dressing. The kernel's own projection refuses a cycle, but this
 * function takes whatever `Snapshot.processes` carried, and a walk with no guard over a cycle never
 * returns — the table would hang the page rather than mis-order it.
 */
export const defaultOrder = (rows: ReadonlyArray<TableRow>): ReadonlyArray<TableRow> => {
	const present = new Set(rows.map((row) => String(row.id)));
	const children = new Map<string, Array<TableRow>>();
	const roots: Array<TableRow> = [];
	for (const row of rows) {
		const parent = Option.filter(Option.map(row.parentId, String), (id) => present.has(id));
		if (Option.isNone(parent)) {
			roots.push(row);
			continue;
		}
		const siblings = children.get(parent.value);
		if (siblings === undefined) children.set(parent.value, [row]);
		else siblings.push(row);
	}
	for (const siblings of children.values()) siblings.sort(byId);
	roots.sort(byId);

	const ordered: Array<TableRow> = [];
	const seen = new Set<string>();
	const visit = (row: TableRow): void => {
		const id = String(row.id);
		if (seen.has(id)) return;
		seen.add(id);
		ordered.push(row);
		for (const child of children.get(id) ?? []) visit(child);
	};
	for (const root of roots) visit(root);
	// Whatever a cycle held: still one row each, still deterministic, just after the forest.
	for (const row of [...rows].sort(byId)) visit(row);
	return ordered;
};

const compareKeys = (left: SortKey, right: SortKey): number => {
	if (typeof left === "number" && typeof right === "number") return left - right;
	return String(left).localeCompare(String(right));
};

/**
 * The rows as the table shows them. `descending` reverses the key comparison only — the default
 * order stays the tiebreak either way, so flipping direction never re-orders two rows that compare
 * equal.
 */
export const sortRows = (
	rows: ReadonlyArray<TableRow>,
	column: PsColumnId,
	direction: SortDirection,
): ReadonlyArray<TableRow> => {
	const base = defaultOrder(rows);
	const rank = new Map(base.map((row, index) => [String(row.id), index]));
	const key = psColumn(column).sortKey;
	const sign = direction === "ascending" ? 1 : -1;
	return [...base].sort((left, right) => {
		const compared = compareKeys(key(left), key(right)) * sign;
		if (compared !== 0) return compared;
		return (rank.get(String(left.id)) ?? 0) - (rank.get(String(right.id)) ?? 0);
	});
};

/** The rows as the table shows them, with `null` meaning "no column sorted": the default order. */
export const orderedRows = (
	rows: ReadonlyArray<TableRow>,
	column: PsColumnId | null,
	direction: SortDirection,
): ReadonlyArray<TableRow> =>
	column === null ? defaultOrder(rows) : sortRows(rows, column, direction);

/**
 * The selection as the table can honour it. A selected process that has left the table resolves to
 * none, so the renderer highlights nothing rather than drawing a row for a process that is gone.
 * The program's own state is cleared separately — see `./state.ts`; this is the guard that holds in
 * the render between the row leaving and that clearing landing.
 */
export const resolveSelection = (
	selected: ProcessId | null,
	rows: ReadonlyArray<TableRow>,
): ProcessId | null => {
	if (selected === null) return null;
	return rows.some((row) => String(row.id) === String(selected)) ? selected : null;
};
