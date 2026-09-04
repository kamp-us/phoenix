/**
 * The first demo program: a counter. Every `tick` adds one and announces the new count on its
 * `ticks` out-port; with `everyMs` set, a dep-keyed Sub ticks it on a timer. Deliberately boring
 * (#7517): it exists to prove the kernel routes, checkpoints and restores, not to anticipate any
 * real program.
 */

import {defineMachine} from "@demlik/tea";
import {Effect} from "effect";
import type {PayloadRejected, PortNotWired} from "../ports/errors.ts";
import {ProcessPorts} from "../ports/ProcessPorts.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {COUNT_KIND, isCount} from "./count.ts";

export type CounterState = {readonly count: number};
export type CounterMsg = {readonly type: "tick"};
export type Announce = {readonly type: "announce"; readonly count: number};

export interface CounterOptions {
	/** Tick on a timer this often; `null` ticks only when told to, which is what the tests want. */
	readonly everyMs: number | null;
}

export const counterId = ProgramId.make("counter");

export const counterProgram = ({everyMs}: CounterOptions): AnyProgram =>
	({
		id: counterId,
		core: defineMachine<CounterState, CounterMsg, Announce, never, unknown>({
			init: (loaded) => [loaded ?? {count: 0}, []],
			update: {
				tick: (state) => [{count: state.count + 1}, [{type: "announce", count: state.count + 1}]],
			},
			subs:
				everyMs === null
					? []
					: [
							{
								deps: () => ({everyMs}),
								source: (_state, dispatch) => {
									const timer = setInterval(() => dispatch({type: "tick"}), everyMs);
									return () => clearInterval(timer);
								},
							},
						],
			// Demlik's `Machine` demands a Promise `interpret` beside the row's `handlers`; the host never reads it (#7576).
			interpret: {announce: () => Promise.resolve()},
		}),
		ports: {ticks: {kind: COUNT_KIND, direction: "out", accepts: isCount}},
		handlers: {
			announce: (cmd: Announce) =>
				Effect.gen(function* () {
					const ports = yield* ProcessPorts;
					yield* ports.emit("ticks", cmd.count);
					return [] as ReadonlyArray<CounterMsg>;
				}),
		},
		capabilities: [],
		identity: {
			package: "@kampus/tuval",
			program: "counter",
			version: "1.0.0",
			digest: "sha256:demo-counter",
		},
		placement: {host: "local"},
	}) satisfies Program<
		CounterState,
		CounterMsg,
		Announce,
		never,
		unknown,
		PayloadRejected | PortNotWired,
		ProcessPorts
	>;
