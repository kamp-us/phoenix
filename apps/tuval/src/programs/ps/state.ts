/**
 * The `ps` program's own state and the machine over it: which column the table sorts on, which way,
 * and which process is selected.
 *
 * Selection is state, not a ref inside the renderer, and that is founder ruling 4's doing: the desk
 * inspector reads the focused window's program selection out of the `Snapshot`, so a selection the
 * renderer kept to itself would be invisible to the one surface that needs it. The cost is that a
 * process leaving the table has to clear the selection through a Msg — `psSelect(null)` — rather
 * than by the row simply disappearing.
 *
 * No Cmd and no host handler: sorting and selecting are transitions over this state and reach
 * nothing outside the process. The one thing the table does reach out for — attaching a process to
 * a window — is a spell call on the shell (`./attach.ts`), not a Cmd of this program's.
 */

import {type Cmd, defineMachine, type Machine} from "@demlik/tea";
import type {ProcessId} from "../../protocol/ids.ts";
import type {PsColumnId} from "./columns.ts";
import {psColumnOrder} from "./columns.ts";
import type {SortDirection} from "./order.ts";

export interface PsState {
	/** `null` is the table's own default order — the forest walk, sorted by no column at all. */
	readonly sortColumn: PsColumnId | null;
	readonly sortDirection: SortDirection;
	/** The row a keyboard user is on. `null` is a table with no row selected, not a hidden zeroth row. */
	readonly selectedProcessId: ProcessId | null;
}

export type PsMsg =
	/** Sort by this column: a new column starts ascending, the current one flips direction. */
	| {readonly type: "ps.sortBy"; readonly column: PsColumnId}
	| {readonly type: "ps.select"; readonly processId: ProcessId | null};

export const psSortBy = (column: PsColumnId): PsMsg => ({type: "ps.sortBy", column});
export const psSelect = (processId: ProcessId | null): PsMsg => ({type: "ps.select", processId});

/**
 * A fresh table: no column sorted, so the rows come out in the forest order, and nothing selected.
 * Sorting by the process column is a different view — ids alphabetically, parents and children
 * interleaved — so the default cannot be spelled as one of the columns.
 */
export const psInitialState: PsState = {
	sortColumn: null,
	sortDirection: "ascending",
	selectedProcessId: null,
};

const isColumnId = (value: unknown): value is PsColumnId =>
	typeof value === "string" && (psColumnOrder as ReadonlyArray<string>).includes(value);

/**
 * Every cell filled, whatever the checkpoint held. A checkpoint is whatever an older build wrote,
 * so a column id that build knew and this one does not falls back to the default order rather than
 * indexing the column table with a name that is no longer there (`../../demo/log.ts` restores for
 * the same reason).
 */
const restore = (loaded: Partial<PsState> | null | undefined): PsState => ({
	sortColumn: isColumnId(loaded?.sortColumn) ? loaded.sortColumn : null,
	sortDirection: loaded?.sortDirection === "descending" ? "descending" : "ascending",
	selectedProcessId: loaded?.selectedProcessId ?? null,
});

/**
 * One Msg over the state, and the whole of this program's behaviour. Exported beside the machine
 * because the tests and the renderer harness run *this* rather than a stub, so a passing test says
 * the table agrees with the shipped reducer instead of with a copy of it.
 */
export const applyPsMsg = (state: PsState, msg: PsMsg): PsState => {
	switch (msg.type) {
		case "ps.sortBy":
			return {
				...state,
				sortColumn: msg.column,
				// Re-picking the current column flips it; a new column always starts ascending, so a
				// reader never lands on a descending table they did not ask for.
				sortDirection:
					state.sortColumn === msg.column && state.sortDirection === "ascending"
						? "descending"
						: "ascending",
			};
		case "ps.select":
			return {...state, selectedProcessId: msg.processId};
	}
};

export const psCore: Machine<PsState, PsMsg, Cmd<never>, never, unknown> = defineMachine<
	PsState,
	PsMsg,
	Cmd<never>,
	never,
	unknown
>({
	init: (loaded) => [restore(loaded), []],
	update: {
		"ps.sortBy": (state, msg) => [applyPsMsg(state, msg), []],
		"ps.select": (state, msg) => [applyPsMsg(state, msg), []],
	},
});

/** A checkpoint as this program reads it back. Exported so the restore rules are testable. */
export const psStateFrom = (loaded: Partial<PsState> | null | undefined): PsState =>
	restore(loaded);

/** Is this a state this program wrote? The renderer holds an erased host, so it asks before reading. */
export const isPsState = (value: unknown): value is PsState => {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Record<string, unknown>;
	return (
		(state.sortColumn === null || isColumnId(state.sortColumn)) &&
		(state.sortDirection === "ascending" || state.sortDirection === "descending") &&
		(state.selectedProcessId === null || typeof state.selectedProcessId === "string")
	);
};

/**
 * This program's selection, read off a state the desk erased. Total on purpose: the desk inspector
 * holds an `AnyWindowHost` and must not assume the state it finds there is this program's.
 */
export const psSelection = (state: unknown): ProcessId | null =>
	isPsState(state) ? state.selectedProcessId : null;
