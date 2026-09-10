/**
 * The two answer paths an authored program has, end to end on a real kernel (#8756): an `ask`
 * answered by its callee, and a spawned child's out-port arriving as the spawner's own event.
 *
 * Driven through live processes rather than through the handlers alone, because what is under test
 * is the delivery the handlers cannot fake — the caller's `Reply` is dispatched by the kernel into a
 * process that is not the one that asked for it (`../process/inbox.ts`), and the child's route is
 * seen at the emit rather than at the spawn.
 *
 * `it.live` because both answers cross a pump: the callee's in-port queue is drained by a forked
 * fiber, so the asking dispatch returns before the answer exists and the assertion has to wait for
 * a real clock rather than a test one.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Option, Schema} from "effect";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import type {ProcessHandle, ProcessId} from "../process/process.ts";
import {type AnyProgram, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {defineProgram} from "./define-program.ts";
import {ask, emit, reply, spawn} from "./effect.ts";
import {port} from "./port.ts";

const kernel = (programs: ReadonlyArray<AnyProgram>) =>
	SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
		Layer.provideMerge(Processes.layer),
		Layer.provideMerge(Layer.mergeAll(Registry.layer(programs), Checkpoints.layer(memoryStores()))),
	);

const handleOf = (process: ProcessId): Effect.Effect<ProcessHandle, never, Processes> =>
	Effect.map(
		Processes.use((live) => live.handle(process)),
		Option.getOrThrow,
	);

/**
 * Read until the answer lands or the attempts run out. A settled read is the assertion's own — a
 * timed-out one answers the last value it saw, so the failure names what was there instead.
 */
const settle = <A>(read: Effect.Effect<A>, done: (value: A) => boolean): Effect.Effect<A> =>
	Effect.gen(function* () {
		let seen = yield* read;
		for (let attempt = 0; attempt < 200 && !done(seen); attempt++) {
			yield* Effect.sleep("5 millis");
			seen = yield* read;
		}
		return seen;
	});

const calleeId = ProgramId.make("answer-path-callee");
const askerId = ProgramId.make("answer-path-asker");

/** The callee: one request port, and a cell whose whole answer is the bound `reply` it was handed. */
const callee = defineProgram({
	id: calleeId,
	ports: {question: port.request(Schema.Number, Schema.String)},
	init: () => ({}),
	update: {
		question: (state: Record<string, never>, event) => [
			state,
			[reply(event.reply, `answered ${event.payload}`)],
		],
	},
});

interface AskerState {
	readonly heard: ReadonlyArray<string>;
}

const asker = defineProgram({
	id: askerId,
	init: (): AskerState => ({heard: []}),
	update: {
		put: (state: AskerState, event: {readonly type: "put"; readonly at: ProcessId}) => [
			state,
			[ask({process: event.at, port: "question"}, 8756, {reply: "answered"})],
		],
		answered: (state: AskerState, event: {readonly type: "answered"; readonly payload: string}) => [
			{heard: [...state.heard, event.payload]},
			[],
		],
	},
});

const routedChildId = ProgramId.make("answer-path-child");
const spawnerId = ProgramId.make("answer-path-spawner");

/** Two out-ports, one of which the spawner names in `on` and the other of which it does not. */
const routedChild = defineProgram({
	id: routedChildId,
	ports: {result: port.out(Schema.String), noise: port.out(Schema.String)},
	init: () => ({}),
	update: {
		say: (
			state: Record<string, never>,
			event: {readonly type: "say"; readonly port: string; readonly text: string},
		) => [state, [emit(event.port, event.text)]],
	},
});

interface SpawnerState {
	readonly reviewed: ReadonlyArray<unknown>;
	readonly stray: ReadonlyArray<unknown>;
}

const spawner = defineProgram({
	id: spawnerId,
	init: (): SpawnerState => ({reviewed: [], stray: []}),
	update: {
		hatch: (state: SpawnerState) => [
			state,
			[spawn({programId: routedChildId, out: {result: "", noise: ""}}, {on: {result: "reviewed"}})],
		],
		spawned: (state: SpawnerState) => [state, []],
		reviewed: (
			state: SpawnerState,
			event: {readonly type: "reviewed"; readonly payload: unknown},
		) => [{...state, reviewed: [...state.reviewed, event.payload]}, []],
		// The port `on` does not name. A cell under the port's own name is what would catch a route
		// that fired for every out-port rather than only the named ones.
		noise: (state: SpawnerState, event: {readonly type: "noise"; readonly payload: unknown}) => [
			{...state, stray: [...state.stray, event.payload]},
			[],
		],
	},
});

describe("an authored program's answer paths", () => {
	it.live("answers an `ask` as the caller's own `Reply` event", () =>
		Effect.gen(function* () {
			const spells = yield* SpawnedProcesses;
			const answering = yield* spells.spawn(calleeId, Option.none());
			const asking = yield* spells.spawn(askerId, Option.none());
			const askerHandle = yield* handleOf(asking);

			yield* askerHandle.dispatch({type: "put", at: answering});

			const state = yield* settle(
				Effect.sync(() => askerHandle.getState() as AskerState),
				(seen) => seen.heard.length > 0,
			);
			assert.deepStrictEqual(state.heard, ["answered 8756"]);
		}).pipe(Effect.provide(kernel([callee, asker])), Effect.orDie),
	);

	it.live(
		"routes a child's named out-port into the spawner's event, and an unnamed one nowhere",
		() =>
			Effect.gen(function* () {
				const spells = yield* SpawnedProcesses;
				const spawning = yield* spells.spawn(spawnerId, Option.none());
				const spawnerHandle = yield* handleOf(spawning);

				yield* spawnerHandle.dispatch({type: "hatch"});
				const rows = yield* ProcessTable.use((table) => table.list);
				const child = rows.find((row) => row.programId === routedChildId);
				assert.ok(child !== undefined, "the spawner hatched a child");
				const childHandle = yield* handleOf(child.id);

				yield* childHandle.dispatch({type: "say", port: "noise", text: "ignore me"});
				yield* childHandle.dispatch({type: "say", port: "result", text: "ship it"});

				const state = yield* settle(
					Effect.sync(() => spawnerHandle.getState() as SpawnerState),
					(seen) => seen.reviewed.length > 0,
				);
				assert.deepStrictEqual(state.reviewed, ["ship it"]);
				assert.deepStrictEqual(state.stray, []);
			}).pipe(Effect.provide(kernel([spawner, routedChild])), Effect.orDie),
	);
});
