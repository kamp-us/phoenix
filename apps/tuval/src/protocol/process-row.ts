/**
 * The process-table row on the wire — the JSON form of `TableRow` (`src/table/row.ts`).
 *
 * The protocol may not import `src/process/`, so the shape is written out here instead of derived.
 * Two fields differ from the in-memory row, and only because JSON has no room for them: `parentId`
 * is `Option<ProcessId>` in the table and `null`-or-id here, and `ports` carries the declaration
 * only (kind and direction), never the predicate or the queue. `protocol.unit.test.ts` projects a
 * real `TableRow` into this schema so the two cannot drift apart unnoticed.
 */

import {Schema} from "effect";
import {ProcessId, ProgramId, Revision} from "./ids.ts";

export const PortDeclaration = Schema.Struct({
	kind: Schema.String,
	direction: Schema.Literals(["in", "out"]),
});
export type PortDeclaration = typeof PortDeclaration.Type;

export const ProcessStateSummary = Schema.Struct({
	lifecycle: Schema.Literals(["running", "stopping"]),
	revision: Revision,
});
export type ProcessStateSummary = typeof ProcessStateSummary.Type;

export const ProcessRow = Schema.Struct({
	id: ProcessId,
	programId: ProgramId,
	parentId: Schema.NullOr(ProcessId),
	ports: Schema.Record(Schema.String, PortDeclaration),
	stateSummary: ProcessStateSummary,
});
export type ProcessRow = typeof ProcessRow.Type;
