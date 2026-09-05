/**
 * The `ps` window renderer: the process table as a real table, driven entirely from the keyboard.
 *
 * This is the accessible twin of the engine-view canvas (founder rulings 6 and 7) — the canvas gets
 * React Flow's own keyboard primitives as they come, and everything a screen-reader or keyboard-only
 * user needs is here instead. So the semantics are load-bearing, not decoration:
 *
 * - A `<table>` element with its native roles and no ARIA role over it, never a grid of divs. The
 *   selected row is marked `aria-current="true"` and not `aria-selected`: `aria-selected` is
 *   prohibited on a `row` outside a `grid`/`treegrid` ("ARIA in HTML", the `tr` row), so on a plain
 *   table it would be an invalid attribute rather than an announced state. `aria-current` is global
 *   and says exactly what is true here — this is the row the keyboard is on.
 * - Focus is managed at the row level: one row carries `tabIndex={0}` and the rest `-1`, so Tab
 *   reaches the table once and the arrow keys walk it (APG's roving-tabindex). `tabindex` is a
 *   global attribute, so a focusable `<tr>` needs no role change to carry it.
 * - Each header is a real `<button>` inside its `<th>`, so sorting is reachable by Tab and Enter with
 *   no key handler of ours, and `aria-sort` on the `<th>` carries the state.
 *
 * The arrow keys move focus imperatively and dispatch the selection together. The dispatch is a Msg
 * to this program's own process and comes back as new state a round-trip later; waiting for it to
 * move focus would leave a keystroke visibly late.
 */

import {Effect, Fiber, Stream} from "effect";
import type {KeyboardEvent, ReactElement} from "react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {ProcessId} from "../../protocol/ids.ts";
import type {AnyWindowHost, ProcessView} from "../../shell/window/index.ts";
import type {TableRow} from "../../table/row.ts";
import {tableRowsFromSnapshot} from "../engine-view/snapshot-rows.ts";
import {callAttach} from "./attach.ts";
import {psColumns} from "./columns.ts";
import {orderedRows, resolveSelection} from "./order.ts";
import {usePsSource} from "./source.tsx";
import {isPsState, type PsMsg, type PsState, psInitialState, psSelect, psSortBy} from "./state.ts";
import "./ps.css";

/**
 * This process's public state, live. The stream never fails and ends on `ProcessGone`, so there is
 * no error arm: a foreign or not-yet-arrived state reads as the initial one rather than a crash.
 */
const usePsState = (host: AnyWindowHost): PsState => {
	const [state, setState] = useState<PsState>(psInitialState);
	const read = host.readProcess as Stream.Stream<ProcessView<unknown>>;
	useEffect(() => {
		const fiber = Effect.runFork(
			Stream.runForEach(read, (view) =>
				Effect.sync(() => {
					if (view._tag === "Live" && isPsState(view.state)) setState(view.state);
				}),
			),
		);
		return () => void Effect.runFork(Fiber.interrupt(fiber));
	}, [read]);
	return state;
};

/** Which row a key press lands on, given where it started. `null` means "leave focus alone". */
const nextIndex = (key: string, from: number, count: number): number | null => {
	switch (key) {
		case "ArrowDown":
			return Math.min(from + 1, count - 1);
		case "ArrowUp":
			return Math.max(from - 1, 0);
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return null;
	}
};

export interface PsTableProps {
	readonly host: AnyWindowHost;
}

export function PsTable({host}: PsTableProps): ReactElement {
	const state = usePsState(host);
	const source = usePsSource();
	const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

	const dispatch = useCallback((msg: PsMsg) => void Effect.runFork(host.dispatch(msg)), [host]);

	const rows: ReadonlyArray<TableRow> = useMemo(
		() => (source === null ? [] : tableRowsFromSnapshot(source.processes)),
		[source],
	);
	const sorted = useMemo(
		() => orderedRows(rows, state.sortColumn, state.sortDirection),
		[rows, state.sortColumn, state.sortDirection],
	);
	const selected = resolveSelection(state.selectedProcessId, rows);

	// The selection is program state (founder ruling 4), so a process leaving the table has to clear
	// it through a Msg; `resolveSelection` only keeps this render honest until that lands.
	useEffect(() => {
		if (state.selectedProcessId !== null && selected === null) dispatch(psSelect(null));
	}, [state.selectedProcessId, selected, dispatch]);

	const focusRow = useCallback((id: ProcessId): void => {
		rowRefs.current.get(String(id))?.focus();
	}, []);

	const onRowKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTableRowElement>, row: TableRow, index: number): void => {
			if (event.key === "Enter") {
				event.preventDefault();
				if (source !== null) callAttach(source.spells, row.id);
				return;
			}
			const next = nextIndex(event.key, index, sorted.length);
			if (next === null) return;
			event.preventDefault();
			const target = sorted[next];
			if (target === undefined) return;
			dispatch(psSelect(target.id));
			focusRow(target.id);
		},
		[dispatch, focusRow, sorted, source],
	);

	if (source === null) {
		return (
			<p className="tuval-placeholder" role="status">
				This window has no desk snapshot, so it has no process table to show.
			</p>
		);
	}

	if (sorted.length === 0) {
		return (
			<p className="tuval-placeholder" role="status">
				No processes are running.
			</p>
		);
	}

	// Tab reaches exactly one row. With nothing selected that is the first one, so the table is
	// reachable before anything in it has been chosen.
	const activeId = String(selected ?? sorted[0]?.id ?? "");

	return (
		<div className="tuval-ps">
			<table className="tuval-ps-table">
				<caption className="tuval-ps-caption">
					Processes — {sorted.length} running. Arrow keys move, Enter opens the process in this
					window.
				</caption>
				<thead>
					<tr>
						{psColumns.map((column) => {
							const active = column.id === state.sortColumn;
							return (
								<th key={column.id} scope="col" aria-sort={active ? state.sortDirection : "none"}>
									<button
										type="button"
										className="tuval-ps-sort"
										onClick={() => dispatch(psSortBy(column.id))}
									>
										{column.header}
										{/* The glyph repeats what `aria-sort` already says, for a sighted
										    reader; Pillar 4 forbids carrying the state on colour alone. */}
										<span aria-hidden="true" className="tuval-ps-sort-marker">
											{active ? (state.sortDirection === "ascending" ? "▲" : "▼") : ""}
										</span>
									</button>
								</th>
							);
						})}
					</tr>
				</thead>
				<tbody>
					{sorted.map((row, index) => {
						const id = String(row.id);
						const isSelected = selected !== null && String(selected) === id;
						return (
							<tr
								key={id}
								ref={(element) => {
									if (element === null) rowRefs.current.delete(id);
									else rowRefs.current.set(id, element);
								}}
								data-process-id={id}
								aria-current={isSelected ? "true" : undefined}
								tabIndex={id === activeId ? 0 : -1}
								onFocus={() => {
									if (!isSelected) dispatch(psSelect(row.id));
								}}
								onKeyDown={(event) => onRowKeyDown(event, row, index)}
							>
								{psColumns.map((column) => (
									<td key={column.id}>{column.cell(row)}</td>
								))}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
