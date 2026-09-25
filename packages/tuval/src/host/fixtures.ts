/** Test fixtures for the host: a small machine with a Cmd that follows up and a dep-keyed Sub. */

import type {NoCtx, Store} from "@demlik/tea";
import {Effect} from "effect";
import type {Sub} from "../registry/sub.ts";
import type {CoreMachine} from "./definition.ts";

export type State =
	| {readonly type: "idle"; readonly count: number}
	| {
			readonly type: "running";
			readonly runId: string;
			readonly count: number;
			readonly acks: number;
	  };

export type Msg =
	| {readonly type: "start"; readonly runId: string}
	| {readonly type: "tick"}
	| {readonly type: "acked"}
	| {readonly type: "halt"};

export type Command = {readonly type: "notify"; readonly count: number};

/** On while a run is going, keyed on its id. */
export type Ticker = Sub<"ticker", {readonly runId: string}>;

export const counterMachine = (): CoreMachine<State, Msg, Command, Ticker, NoCtx> => ({
	init: (loaded) => [loaded ?? {type: "idle", count: 0}, []],
	update: {
		start: (state, msg) => [{type: "running", runId: msg.runId, count: state.count, acks: 0}, []],
		tick: (state) =>
			state.type === "running"
				? [{...state, count: state.count + 1}, [{type: "notify", count: state.count + 1}]]
				: [state, []],
		acked: (state) =>
			state.type === "running" ? [{...state, acks: state.acks + 1}, []] : [state, []],
		halt: (state) => [{type: "idle", count: state.count}, []],
	},
	subs: [
		{
			type: "ticker",
			deps: (state) => (state.type === "running" ? {runId: state.runId} : null),
		},
	],
});

/**
 * The ticker's runner: logs its start, holds, and logs its stop when its scope closes. Left to
 * inference, so a definition built on it reads no error or service off it.
 */
export const counterSubscribe = (log: string[]) => ({
	ticker: () =>
		Effect.acquireRelease(
			Effect.sync(() => void log.push("sub:start")),
			() => Effect.sync(() => void log.push("sub:stop")),
		).pipe(Effect.andThen(Effect.never)),
});

export const recordingStore = <S>(saves: S[]): Store<S> => ({
	load: () => Promise.resolve(null),
	save: (state) => {
		saves.push(structuredClone(state));
		return Promise.resolve();
	},
	migrate: (raw) => raw as S | null,
});
