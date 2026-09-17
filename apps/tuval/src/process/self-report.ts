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
 *
 * The latch is runtime memory and nothing persists it, so a restored process starts with neither
 * line. `seedSelfReport` is the other write into it: at spawn the kernel asks the row what its
 * loaded state derives and records that, because a restored process emits nothing until some later
 * transition moves a line — which for a stable title is never (#8812).
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
 * The line this row would latch for one port, or none — the whole admission test, written once so
 * the two writers into the latch cannot disagree about what it holds. A port outside the two, a
 * payload that is not a line, and a port the row does not declare out are all outside the contract.
 */
const latchable = (
	row: AnyProgram,
	port: string,
	payload: unknown,
): Option.Option<readonly [SelfReportPort, string]> =>
	(port === TITLE_PORT || port === STATUS_PORT) && isLine(payload) && declaresOutPort(row, port)
		? Option.some([port, payload] as const)
		: Option.none();

/**
 * What a restored process would otherwise never say: the lines its row derives off the state it
 * booted on, recorded into the latch at spawn (#8812).
 *
 * Read off `AnyProgram.derivedLines`, so a row that derives none is a no-op here. It runs on every
 * spawn rather than on restores alone: a fresh boot's `init` emits the same lines off the same
 * state, so this restates them rather than contradicting them, and the kernel is spared a
 * fresh-versus-restored flag it has no other use for.
 */
export const seedSelfReport = (
	row: AnyProgram,
	state: unknown,
	record: (port: SelfReportPort, line: string) => void,
): void => {
	if (row.derivedLines === undefined) return;
	for (const [port, line] of Object.entries(row.derivedLines(state))) {
		const latched = latchable(row, port, line);
		if (Option.isSome(latched)) record(latched.value[0], latched.value[1]);
	}
};

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
				const latched = latchable(row, port, payload);
				if (Option.isSome(latched)) record(latched.value[0], latched.value[1]);
				return ports.emit(port, payload);
			}),
	});
