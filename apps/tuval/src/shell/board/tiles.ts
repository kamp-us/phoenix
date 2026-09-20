/**
 * The board's tile model: process-table rows in, a nested tile forest out. Pure, so every claim the
 * board makes about what it draws is settled without a DOM (`./tiles.unit.test.ts`).
 *
 * It reads the base contract and nothing else — the kernel row plus the two generic ports the
 * kernel latches (`../../process/self-report.ts`). Nothing here knows what an AI agent is, which is
 * what lets a demo counter and a Claude session sit on one board as equals (#8715 R8.1). A program
 * that declares neither port still gets a whole tile; `title` and `status` are then `null` and the
 * tile is its program id, its state and its port count.
 */

import {Option} from "effect";
import type {ProcessId} from "../../process/process.ts";
import type {TableRow} from "../../table/row.ts";

export interface Tile {
	readonly processId: ProcessId;
	readonly programId: string;
	readonly lifecycle: "running" | "stopping";
	/** The newest `title@1` line, or `null` for a process that has published none. */
	readonly title: string | null;
	/** The newest `status@1` line, same rule. */
	readonly status: string | null;
	/** How many ports the program declares — the last thing the kernel row gives a tile with no lines. */
	readonly ports: number;
	readonly children: readonly Tile[];
}

const tileOf = (row: TableRow, children: readonly Tile[]): Tile => ({
	processId: row.id,
	programId: row.programId,
	lifecycle: row.stateSummary.lifecycle,
	title: Option.getOrNull(row.title),
	status: Option.getOrNull(row.status),
	ports: Object.keys(row.ports).length,
	children,
});

/**
 * The forest, in the order the rows arrived.
 *
 * A row whose parent is not in this set is a root rather than a dropped row: the board's first
 * promise is that every live process has a tile, and a child whose parent has already stopped is
 * exactly the process an operator most wants to find. The `seen` set is what keeps a parent chain
 * that loops from recursing forever — the kernel builds none, and a surface that hangs on a
 * malformed table is worse than one that draws it flat.
 */
export const tilesOf = (rows: Iterable<TableRow>): readonly Tile[] => {
	const all = [...rows];
	const present = new Set(all.map((row) => row.id));
	const childrenOf = new Map<ProcessId, TableRow[]>();
	const roots: TableRow[] = [];
	for (const row of all) {
		const parent = Option.getOrNull(row.parentId);
		if (parent === null || parent === row.id || !present.has(parent)) {
			roots.push(row);
			continue;
		}
		const held = childrenOf.get(parent);
		if (held === undefined) childrenOf.set(parent, [row]);
		else held.push(row);
	}
	const drawn = new Set<ProcessId>();
	const build = (row: TableRow, seen: ReadonlySet<ProcessId>): Tile => {
		drawn.add(row.id);
		if (seen.has(row.id)) return tileOf(row, []);
		const next = new Set(seen).add(row.id);
		return tileOf(
			row,
			(childrenOf.get(row.id) ?? []).map((child) => build(child, next)),
		);
	};
	const tiles = roots.map((row) => build(row, new Set()));
	// A cycle with no row outside it — a↔b — has no root at all, so walking the roots reaches
	// neither. Every row the walk missed is drawn at the top level rather than dropped: a process
	// the table names and the board does not show is the one failure this surface cannot have.
	for (const row of all) if (!drawn.has(row.id)) tiles.push(build(row, new Set()));
	return tiles;
};

/** Every process id on the board, parents and children alike. */
export const tileIds = (tiles: readonly Tile[]): ReadonlySet<ProcessId> => {
	const ids = new Set<ProcessId>();
	const walk = (tile: Tile): void => {
		ids.add(tile.processId);
		for (const child of tile.children) walk(child);
	};
	for (const tile of tiles) walk(tile);
	return ids;
};

/**
 * Which tiles are new since the last board — the ones that animate in.
 *
 * `null` for `previous` is "this board has not drawn yet", and answers the empty set: the first
 * paint of a desk already running six processes is not six spawns, and animating it would say
 * something false about every one of them.
 */
export const enteredSince = (
	previous: ReadonlySet<ProcessId> | null,
	current: ReadonlySet<ProcessId>,
): ReadonlySet<ProcessId> => {
	if (previous === null) return new Set();
	const entered = new Set<ProcessId>();
	for (const id of current) if (!previous.has(id)) entered.add(id);
	return entered;
};
