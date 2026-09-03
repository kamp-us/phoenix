/**
 * Test fixtures for the ports slice: a program whose ports are the only thing that varies. Each
 * program's private Msg is deliberately distinct from every port payload, which is what the
 * type-level test in `boundary.unit.test.ts` leans on.
 */

import {type Cmd, defineMachine} from "@demlik/tea";
import type {AnyProgram, PortBound, PortSchema, Program} from "../registry/program.ts";
import {ProgramId} from "../registry/program.ts";

export type State = {readonly count: number};
export type Msg = {readonly type: "tick"};

export const counter = defineMachine<State, Msg, Cmd<never>, never, unknown>({
	init: (loaded) => [loaded ?? {count: 0}, []],
	update: {tick: (state) => [{count: state.count + 1}, []]},
});

export const isNumber = (p: unknown): p is number => typeof p === "number";
export const isString = (p: unknown): p is string => typeof p === "string";

export const bound: PortBound = {capacity: 8, overflow: "suspend"};

export const program = (id: string, ports: Readonly<Record<string, PortSchema>>): AnyProgram =>
	({
		id: ProgramId.make(id),
		core: counter,
		ports,
		handlers: {},
		capabilities: [],
		identity: {package: "@kampus/tuval", program: id, version: "1.0.0", digest: `sha256:${id}`},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Cmd<never>, never, unknown, never, never>;

/** Emits numbers on `ticks` (`tick/v1`). */
export const producer = program("producer", {
	ticks: {kind: "tick/v1", direction: "out", accepts: isNumber},
});

/** Consumes numbers on `ticks` (`tick/v1`) under `bound`. */
export const consumer = (id = "consumer", inBound: PortBound = bound) =>
	program(id, {
		ticks: {kind: "tick/v1", direction: "in", accepts: isNumber, bound: inBound},
	});

/** Consumes strings on `verdicts` (`verdict/v1`): the kind spike #7379 refused a tick route into. */
export const judge = program("judge", {
	verdicts: {kind: "verdict/v1", direction: "in", accepts: isString, bound},
});
