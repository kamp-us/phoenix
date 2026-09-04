/**
 * The second demo program: a log. Every count arriving on its `ticks` in-port is recorded in
 * state and written out through `write` — the one effect the restart proof counts (#7517). As
 * boring as the counter, for the same reason.
 */

import {defineMachine} from "@demlik/tea";
import {Effect} from "effect";
import {type AnyProgram, type Program, ProgramId, type RendererRef} from "../registry/program.ts";
import {COUNT_KIND, isCount} from "./count.ts";

export type LogState = {
	readonly lines: ReadonlyArray<number>;
	/** Keystrokes the shell forwarded into this process, newest last. See `./counter.ts`. */
	readonly keys: ReadonlyArray<string>;
};
export type LogMsg =
	| {readonly type: "record"; readonly count: number}
	| {readonly type: "key"; readonly key: string};
export type Print = {readonly type: "print"; readonly line: string};

export interface LogOptions {
	/** Where a line goes: the terminal for `pnpm dev`, a probe in the tests. */
	readonly write: (line: string) => Effect.Effect<void>;
}

export const logId = ProgramId.make("log");

export const logProgram = ({write}: LogOptions): AnyProgram =>
	({
		id: logId,
		core: defineMachine<LogState, LogMsg, Print, never, unknown>({
			init: (loaded) => [loaded ?? {lines: [], keys: []}, []],
			update: {
				record: (state, msg) => [
					{...state, lines: [...state.lines, msg.count]},
					[{type: "print", line: `count ${msg.count}`}],
				],
				key: (state, msg) => [
					{...state, keys: [...state.keys, msg.key]},
					[{type: "print", line: `key ${msg.key}`}],
				],
			},
			// Demlik's `Machine` demands a Promise `interpret` beside the row's `handlers`; the host never reads it (#7576).
			interpret: {print: () => Promise.resolve()},
		}),
		ports: {
			ticks: {
				kind: COUNT_KIND,
				direction: "in",
				accepts: isCount,
				bound: {capacity: 16, overflow: "suspend"},
			},
		},
		receive: {ticks: (count: number): LogMsg => ({type: "record", count})},
		handlers: {
			print: (cmd: Print) => Effect.as(write(cmd.line), [] as ReadonlyArray<LogMsg>),
		},
		capabilities: [],
		// Headless rows never bind a window (`../shell/picker/entries.ts`); see `./counter.ts` for why
		// the page's own table is keyed by program id rather than by this reference.
		renderer: {kind: "host-native", ref: "tuval/demo/log"} satisfies RendererRef,
		identity: {
			package: "@kampus/tuval",
			program: "log",
			version: "1.0.0",
			digest: "sha256:demo-log",
		},
		placement: {host: "local"},
	}) satisfies Program<LogState, LogMsg, Print, never, unknown, never, never>;
