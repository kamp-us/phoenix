/**
 * The process table as an ordinary out-port. `processTablePort` is the declaration a program row
 * carries under `ports`, typed like any other; `ProcessTablePort` is the kernel-side service that
 * reads the `ProcessTable` and pumps its changes onto that port through the wiring. Nothing here
 * reaches `Processes`: the only service this slice takes is the read-only table.
 */

import {Context, Effect, Layer, Stream} from "effect";
import type {PayloadRejected, PortNotWired} from "../ports/errors.ts";
import type {PortRef} from "../ports/graph.ts";
import type {Wiring} from "../ports/wiring.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import type {OutPort} from "../registry/program.ts";
import {isTableEvent, type TableEvent, type TableRow, toTableRow} from "./row.ts";

export const PROCESS_TABLE_KIND = "tuval/process-table/v1";

export const processTablePort: OutPort<TableEvent> = {
	kind: PROCESS_TABLE_KIND,
	direction: "out",
	accepts: isTableEvent,
};

export class ProcessTablePort extends Context.Service<
	ProcessTablePort,
	{
		readonly rows: Effect.Effect<ReadonlyArray<TableRow>>;
		/** Every change from the moment the stream runs: spawn, stop, and each state-summary move. */
		readonly changes: Stream.Stream<TableEvent>;
		/** Emit every change on `from`, an out-port of `PROCESS_TABLE_KIND`; runs until interrupted. */
		readonly feed: (
			wiring: Wiring,
			from: PortRef,
		) => Effect.Effect<void, PayloadRejected | PortNotWired>;
	}
>()("tuval/ProcessTablePort") {
	static readonly layer: Layer.Layer<ProcessTablePort, never, ProcessTable> = Layer.effect(
		ProcessTablePort,
		make(),
	);
}

function make() {
	return Effect.gen(function* () {
		const table = yield* ProcessTable;
		const changes = Stream.map(
			table.changes,
			(change): TableEvent => ({kind: change.kind, row: toTableRow(change.row)}),
		);
		const feed = Effect.fn("Tuval.ProcessTablePort.feed")(function* (
			wiring: Wiring,
			from: PortRef,
		) {
			yield* Stream.runForEach(changes, (event) => Effect.asVoid(wiring.emit(from, event)));
		});
		return ProcessTablePort.of({
			rows: Effect.map(table.list, (rows) => rows.map(toTableRow)),
			changes,
			feed,
		});
	});
}
