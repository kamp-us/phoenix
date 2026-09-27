/**
 * An authored `send`, `ask`, `stop` and `spawn` ask the `ProcessBoundary` in their process's spawn
 * set before they reach anything (#9689), naming the process they run as. A refusal fails the
 * effect, so nothing is delivered, stopped or spawned; with no boundary, nothing is asked. The
 * `process spawn`, `process send` and `process read` spells ask it the same way when a process
 * calls them.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit, Layer, Option} from "effect";
import {processSpells, SpawnedProcesses} from "../commands/core/process.ts";
import {ClientId, type Scope as SpellScope, WorkspaceId} from "../commands/spell.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {ProcessId} from "../process/process.ts";
import {CrossingRefused, ProcessBoundary} from "../process/subprojects.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {defineProgram} from "./define-program.ts";
import {ask, send, spawn, stop} from "./effect.ts";

const targetId = ProgramId.make("target");
const callerId = ProgramId.make("caller");
const beyond = ProcessId.make("beyond/main");

const target = defineProgram({id: targetId, init: () => ({}), update: {}});

const caller = defineProgram({
	id: callerId,
	init: () => ({}),
	update: {
		send: (state: object) => [state, [send({process: beyond, port: "in"}, 1)]],
		ask: (state: object) => [state, [ask({process: beyond, port: "in"}, 1, {reply: "answered"})]],
		spawn: (state: object) => [state, [spawn({programId: targetId, out: {}})]],
		stop: (state: object) => [state, [stop(beyond)]],
	},
});

const kernel = SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
	Layer.provideMerge(Processes.layer),
	Layer.provideMerge(
		Layer.mergeAll(Registry.layer([caller, target]), Checkpoints.layer(memoryStores())),
	),
);

/** A boundary that refuses everything and writes down what it was asked. */
const refusing = (asked: Array<string>) =>
	ProcessBoundary.of({
		reach: (from, to) =>
			Effect.andThen(
				Effect.sync(() => asked.push(`reach ${from} -> ${to}`)),
				Effect.fail(new CrossingRefused({from, to, reason: "refused"})),
			),
		spawn: (from, program) =>
			Effect.andThen(
				Effect.sync(() => asked.push(`spawn ${from} -> ${program}`)),
				Effect.fail(new CrossingRefused({from, to: program, reason: "refused"})),
			),
	});

/** Spawn a caller under `boundary`, dispatch `type` into it, and read what followed. */
const poke = (
	type: "send" | "ask" | "stop" | "spawn",
	boundary: Option.Option<ProcessBoundary["Service"]>,
) =>
	Effect.gen(function* () {
		const spawned = yield* SpawnedProcesses;
		const start = spawned.spawn(callerId, Option.none());
		const id = yield* Option.isSome(boundary)
			? Effect.provideService(start, ProcessBoundary, boundary.value)
			: start;
		const handle = Option.getOrThrow(yield* Processes.use((processes) => processes.handle(id)));
		const exit = yield* Effect.exit(handle.dispatch({type}));
		const live = (yield* ProcessTable.use((table) => table.list)).map((row) => row.programId);
		return {id, exit, live};
	}).pipe(Effect.provide(kernel));

describe("an authored reach across the subproject boundary", () => {
	for (const type of ["send", "ask", "stop"] as const) {
		it.effect(`asks the boundary before a ${type}, and a refusal fails it`, () =>
			Effect.gen(function* () {
				const asked: Array<string> = [];
				const {id, exit} = yield* poke(type, Option.some(refusing(asked)));
				assert.isTrue(Exit.isFailure(exit));
				assert.deepStrictEqual(asked, [`reach ${id} -> ${beyond}`]);
			}),
		);
	}

	it.effect("asks the boundary before a spawn, and a refusal spawns nothing", () =>
		Effect.gen(function* () {
			const asked: Array<string> = [];
			const {id, exit, live} = yield* poke("spawn", Option.some(refusing(asked)));
			assert.isTrue(Exit.isFailure(exit));
			assert.deepStrictEqual(asked, [`spawn ${id} -> ${targetId}`]);
			assert.deepStrictEqual(live, [callerId]);
		}),
	);

	it.effect("asks nothing with no boundary in the spawn set", () =>
		Effect.gen(function* () {
			const {exit, live} = yield* poke("spawn", Option.none());
			assert.isTrue(Exit.isSuccess(exit));
			assert.deepStrictEqual(live, [callerId, targetId]);
		}),
	);
});

/** The spell at `process.<verb>`, called as `from` when a process calls it. */
const callSpell = (verb: "spawn" | "send" | "read", args: unknown, from: ProcessId | undefined) => {
	const spell = processSpells.find((each) => each.path[1] === verb);
	if (spell === undefined) throw new Error(`no process.${verb} spell`);
	const scope: SpellScope = {
		workspace: WorkspaceId.make("ws-1"),
		client: ClientId.make("test"),
		...(from === undefined ? {} : {process: from}),
	};
	return spell.execute(args, scope) as Effect.Effect<unknown, unknown, SpawnedProcesses>;
};

describe("a process spell called across the subproject boundary", () => {
	const from = ProcessId.make("bystander/main");
	const cases = [
		{verb: "spawn", args: {program: targetId}, asked: `spawn ${from} -> ${targetId}`},
		{
			verb: "send",
			args: {process: beyond, port: "in", payload: 1},
			asked: `reach ${from} -> ${beyond}`,
		},
		{verb: "read", args: {process: beyond, port: "out"}, asked: `reach ${from} -> ${beyond}`},
	] as const;

	for (const {verb, args, asked: expected} of cases) {
		it.effect(`asks the boundary before process.${verb}, and a refusal fails it`, () =>
			Effect.gen(function* () {
				const asked: Array<string> = [];
				const exit = yield* Effect.exit(
					Effect.provideService(callSpell(verb, args, from), ProcessBoundary, refusing(asked)),
				);
				assert.isTrue(Exit.isFailure(exit));
				assert.deepStrictEqual(asked, [expected]);
				const live = yield* ProcessTable.use((table) => table.list);
				assert.deepStrictEqual(live, []);
			}).pipe(Effect.provide(kernel)),
		);

		it.effect(`asks nothing before process.${verb} called from outside any process`, () =>
			Effect.gen(function* () {
				const asked: Array<string> = [];
				yield* Effect.exit(
					Effect.provideService(callSpell(verb, args, undefined), ProcessBoundary, refusing(asked)),
				);
				assert.deepStrictEqual(asked, []);
			}).pipe(Effect.provide(kernel)),
		);
	}
});
