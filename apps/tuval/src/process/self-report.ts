/**
 * The two out-ports any program may declare to say what it is and how it is doing: `title@1`, one
 * line, and `status@1`, one short line. Both optional — a program declaring neither is a whole
 * program — and both generic: nothing a surface reads here says what kind of program it is looking
 * at, which is what lets the demo counter and a Claude session sit on one board as equals (#8715
 * R8.1). Two names, one line each; growing them into a typed-metrics protocol is a ruled
 * rabbit-hole on that epic.
 *
 * The kernel latches the newest line a process emits on each, whatever spawn path it came up
 * through (`Processes.ts`), so a reader asks the process table and never the wiring.
 */

import {type Context, Effect, Option} from "effect";
import {ProcessPorts} from "../ports/ProcessPorts.ts";
import type {AnyProgram, OutPort} from "../registry/program.ts";

export const TITLE_PORT = "title@1";
export const STATUS_PORT = "status@1";

export const TITLE_KIND = "tuval/title/v1";
export const STATUS_KIND = "tuval/status/v1";

export type SelfReportPort = typeof TITLE_PORT | typeof STATUS_PORT;

const isLine = (payload: unknown): payload is string => typeof payload === "string";

/** Declared under `TITLE_PORT` in a program's `ports` by a program that publishes a title. */
export const titlePort: OutPort<string> = {kind: TITLE_KIND, direction: "out", accepts: isLine};

/** Declared under `STATUS_PORT` by a program that publishes a status line. */
export const statusPort: OutPort<string> = {kind: STATUS_KIND, direction: "out", accepts: isLine};

/** The newest line a process said on each port; `none` until it says one, and for a port it never declared. */
export interface SelfReport {
	readonly title: Option.Option<string>;
	readonly status: Option.Option<string>;
}

export const noSelfReport: SelfReport = {title: Option.none(), status: Option.none()};

const declaresOutPort = (row: AnyProgram, port: SelfReportPort): boolean =>
	row.ports[port]?.direction === "out";

/**
 * `ports` again, recording every `title@1`/`status@1` line on its way past.
 *
 * Recorded before delivery and independent of it: the latch is what the process said about itself,
 * so a graph node whose title port no route reaches keeps its title even though the emit under it
 * fails `PortNotWired` (#7789). A port the program does not declare out, and a payload that is not
 * a line, are outside this contract and pass straight through.
 */
export const latching = (
	row: AnyProgram,
	ports: Context.Service.Shape<typeof ProcessPorts>,
	record: (port: SelfReportPort, line: string) => void,
): Context.Service.Shape<typeof ProcessPorts> =>
	ProcessPorts.of({
		emit: (port, payload) =>
			Effect.suspend(() => {
				if (
					(port === TITLE_PORT || port === STATUS_PORT) &&
					isLine(payload) &&
					declaresOutPort(row, port)
				) {
					record(port, payload);
				}
				return ports.emit(port, payload);
			}),
	});
