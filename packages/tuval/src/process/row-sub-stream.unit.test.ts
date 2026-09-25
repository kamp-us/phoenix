/**
 * A program row's Sub runner is a Stream (#9790): the host hands each element to `update` as a Msg,
 * in the order the Stream emits them, and interrupts the Stream when the Sub leaves the desired set.
 */

import type {Cmd} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Stream} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {type AnyProgram, type Program, type ProgramCore, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import type {Sub} from "../registry/sub.ts";
import {Processes} from "./Processes.ts";
import type {ProcessTable} from "./ProcessTable.ts";

type State = {readonly on: boolean; readonly seen: ReadonlyArray<string>};
type Msg =
	| {readonly type: "on"}
	| {readonly type: "off"}
	| {readonly type: "noted"; readonly note: string};
type Feed = Sub<"feed", true>;

const core: ProgramCore<State, Msg, Cmd<never>, Feed, unknown> = {
	init: (loaded) => [loaded ?? {on: false, seen: []}, []],
	update: {
		on: (state: State) => [{...state, on: true}, []],
		off: (state: State) => [{...state, on: false}, []],
		noted: (state: State, msg: Extract<Msg, {type: "noted"}>) => [
			{...state, seen: [...state.seen, msg.note]},
			[],
		],
	},
	subs: [{type: "feed", deps: (state) => (state.on ? true : null)}],
};

const id = ProgramId.make("feed");

/** Three notes, then held open, so only the Sub leaving can end it. */
const feedRow = (log: string[]): AnyProgram =>
	({
		id,
		core,
		ports: {},
		handlers: {},
		subs: {
			feed: () =>
				Stream.fromIterable(["one", "two", "three"]).pipe(
					Stream.map((note): Msg => ({type: "noted", note})),
					Stream.concat(Stream.never),
					Stream.ensuring(Effect.sync(() => void log.push("finalized"))),
				),
		},
		capabilities: [],
		identity: {package: "@kampus/tuval", program: "feed", version: "1.0.0", digest: "sha256:feed"},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Cmd<never>, Feed, unknown, never, never>;

const withKernel = <A, E>(
	rows: ReadonlyArray<AnyProgram>,
	body: Effect.Effect<A, E, Processes | ProcessTable>,
) =>
	body.pipe(
		Effect.provide(
			Processes.layer.pipe(
				Layer.provide([Registry.layer(rows), Checkpoints.layer(memoryStores())]),
			),
		),
	);

/** A Sub drains on its own fiber, so a dispatch's own quiescence does not cover what it emits. */
const settle = Effect.sleep("20 millis");

describe("a program row's Stream Sub", () => {
	it.live("hands each element to update in order, and interrupts the Stream when it leaves", () => {
		const log: string[] = [];
		return Effect.scoped(
			withKernel(
				[feedRow(log)],
				Effect.gen(function* () {
					const processes = yield* Processes;
					const handle = yield* processes.spawn(id, {services: Context.empty()});
					yield* handle.dispatch({type: "on"});
					yield* settle;

					assert.deepStrictEqual((handle.getState() as State).seen, ["one", "two", "three"]);
					assert.deepStrictEqual(log, []);

					yield* handle.dispatch({type: "off"});
					yield* settle;

					assert.deepStrictEqual(log, ["finalized"]);
					assert.deepStrictEqual((handle.getState() as State).seen, ["one", "two", "three"]);
				}),
			),
		);
	});
});
