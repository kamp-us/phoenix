/**
 * The one seam between the wire and the projection.
 *
 * Founder ruling 2 on #7500: the page reads the process table from `Snapshot.processes` and from no
 * port of its own, so the canvas and the `ps` table can never disagree. The snapshot's `ProcessRow`
 * (`src/protocol/process-row.ts`) is the JSON form of the kernel's `TableRow`, and it differs in
 * exactly two ways JSON forced: `parentId` is `null`-or-id rather than an `Option`, and `recency`
 * is desk state the projection has no use for. Converting here means the projection keeps taking
 * the kernel's own row, and every renderer downstream converts in one place instead of each
 * re-deriving the mapping.
 */

import {Option} from "effect";
import type {ProcessRow} from "../../protocol/process-row.ts";
import type {TableRow} from "../../table/row.ts";

export const tableRowFromProcessRow = (row: ProcessRow): TableRow => ({
	id: row.id,
	programId: row.programId,
	parentId: Option.fromNullOr(row.parentId),
	ports: row.ports,
	stateSummary: row.stateSummary,
});

export const tableRowsFromSnapshot = (
	processes: ReadonlyArray<ProcessRow>,
): ReadonlyArray<TableRow> => processes.map(tableRowFromProcessRow);
