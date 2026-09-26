/**
 * A reload asked for by a process whose own row changed (#9820): the desk's `config:reload` key runs
 * the reload inside the shell's own handler, and a swap waits for the fold in flight. The reload
 * answers without waiting for its caller's swap, and that swap lands once the handler has settled.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Checkpoints} from "@kampus/tuval-sdk/kernel/durability/Checkpoints";
import {memoryStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import type {ProcessTable} from "@kampus/tuval-sdk/kernel/process/ProcessTable";
import {type AnyProgram, type Program, ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Registry} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {Effect, Layer} from "effect";
import {applyReload, rowsOnly} from "./reload.ts";

type State = {readonly by: string; readonly pending: ReadonlyArray<string>};
type Msg =
	| {readonly type: "reload"}
	| {readonly type: "reloaded"; readonly pending: ReadonlyArray<string>}
	| {readonly type: "stamp"};
type Reload = {readonly type: "reload"};

const DESK = ProgramId.make("desk");

type Stamp = (state: State) => readonly [State, ReadonlyArray<Reload>];

/**
 * A desk-like row whose `reload` Cmd runs the reload from inside its own handler. `stamp` is the
 * code an edit moves, so the two rows below write it out rather than closing over a value.
 */
const deskRow = (stamp: Stamp, next: () => ReadonlyArray<AnyProgram>): AnyProgram =>
	({
		id: DESK,
		core: defineMachine<State, Msg, Reload, never, unknown>({
			init: (loaded) => [loaded ?? {by: "booted", pending: []}, []],
			update: {
				reload: (state) => [state, [{type: "reload"}]],
				reloaded: (state, msg) => [{...state, pending: msg.pending}, []],
				stamp,
			},
		}),
		ports: {},
		handlers: {
			reload: () =>
				Effect.map(
					applyReload(rowsOnly([current]), rowsOnly(next())),
					(applied): ReadonlyArray<Msg> => [{type: "reloaded", pending: applied.pending}],
				),
		},
		capabilities: [],
		identity: {package: "@kampus/tuval", program: "desk", version: "1.0.0", digest: "sha256:d"},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Reload, never, unknown, never, ProcessTable | Processes>;

const edited: AnyProgram = deskRow(
	(state) => [{...state, by: "edited"}, []],
	() => [],
);
const current: AnyProgram = deskRow(
	(state) => [{...state, by: "booted"}, []],
	() => [edited],
);

describe("a reload run from a changed process's own handler", () => {
	it.live("answers at once and switches that process once its handler has settled", () =>
		Effect.gen(function* () {
			const processes = yield* Processes;
			const services = yield* Effect.context<Processes | ProcessTable>();
			const desk = yield* processes.spawn(DESK, {services});

			yield* desk.dispatch({type: "reload"}).pipe(
				Effect.timeoutOrElse({
					duration: "2 seconds",
					orElse: () => Effect.die("the reload waited on its own caller's swap"),
				}),
			);
			assert.deepStrictEqual((desk.getState() as State).pending, [desk.id]);

			for (let attempt = 0; attempt < 200; attempt += 1) {
				yield* desk.dispatch({type: "stamp"});
				if ((desk.getState() as State).by === "edited") break;
				yield* Effect.sleep("10 millis");
			}
			assert.strictEqual((desk.getState() as State).by, "edited", "the deferred swap never landed");
		}).pipe(
			Effect.provide(
				Processes.layer.pipe(
					Layer.provideMerge(Registry.layer([current]).pipe(Layer.orDie)),
					Layer.provide(Checkpoints.layer(memoryStores())),
				),
			),
		),
	);
});
