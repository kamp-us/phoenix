/**
 * The proof that a command's bare `send("pr", pr)` reaches a process (#8898), on a real kernel
 * rather than through the handlers alone: the resolution reads the live `ProcessTable`, and the
 * payload it addresses crosses the in-port's own queue and pump before the state it moved can be
 * read back. A stubbed `SpawnedProcesses` can show the address; only a live process shows the reach.
 *
 * `it.live` because the delivery crosses a pump: the in-port queue is drained by a forked fiber, so
 * the spell's `execute` returns before the arrival has been folded and the assertion has to wait on
 * a real clock. Every wait is bounded and answers the last value it saw.
 */

import {assert, describe, it} from "@effect/vitest";
import {defineProgram} from "@kampus/tuval-sdk/kernel/authoring/define-program";
import {send} from "@kampus/tuval-sdk/kernel/authoring/effect";
import {port} from "@kampus/tuval-sdk/kernel/authoring/port";
import {SpawnedProcesses} from "@kampus/tuval-sdk/kernel/commands/core/process";
import {ClientId, type Scope, WorkspaceId} from "@kampus/tuval-sdk/kernel/commands/spell";
import {Checkpoints} from "@kampus/tuval-sdk/kernel/durability/Checkpoints";
import {memoryStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {compile} from "@kampus/tuval-sdk/kernel/ports/compile";
import {type Graph, NodeId} from "@kampus/tuval-sdk/kernel/ports/graph";
import {open} from "@kampus/tuval-sdk/kernel/ports/wiring";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import type {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {type AnyProgram, ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Registry} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {Effect, Layer, Option, Schema} from "effect";
import {launch} from "../launch/launch.ts";

const kernel = (programs: ReadonlyArray<AnyProgram>) =>
	SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
		Layer.provideMerge(Processes.layer),
		Layer.provideMerge(Layer.mergeAll(Registry.layer(programs), Checkpoints.layer(memoryStores()))),
	);

const reviewerId = ProgramId.make("own-process-review");

interface State {
	readonly seen: ReadonlyArray<number>;
}

/**
 * The shape the ruling asks an author to be able to write: one in-port, and a command whose whole
 * body is a bare port name. Nothing here mints or reads a process id.
 */
const reviewer = defineProgram({
	id: reviewerId,
	ports: {pr: port.in(Schema.Number)},
	init: (): State => ({seen: []}),
	update: {
		pr: (state: State, event: {readonly type: "pr"; readonly payload: number}) => [
			{seen: [...state.seen, event.payload]},
			[],
		],
	},
	commands: {review: {args: Schema.Number, run: (pr: number) => send("pr", pr)}},
});

const reviewSpell = (reviewer.spells ?? [])[0];
if (reviewSpell === undefined) throw new Error("the program declares no `review` spell");

/** A call from outside any window, which is the case that has no caller process to fall back on. */
const anonymous: Scope = {
	workspace: WorkspaceId.make("tuval/test"),
	client: ClientId.make("tuval/test"),
};

const callReview = (pr: number, from: Scope = anonymous) =>
	reviewSpell.execute(pr, from) as Effect.Effect<void, unknown, never>;

const spawnReviewer = SpawnedProcesses.use((processes) =>
	processes.spawn(reviewerId, Option.none()),
);

const stateOf = (process: ProcessId) =>
	Effect.map(
		Processes.use((live) => live.handle(process)),
		(held) => (Option.isSome(held) ? (held.value.getState() as State) : {seen: []}),
	);

/** Read until the arrival has been folded, or the attempts run out; then answer what was there. */
const settle = (process: ProcessId) =>
	Effect.gen(function* () {
		let seen = yield* stateOf(process);
		for (let attempt = 0; attempt < 200 && seen.seen.length === 0; attempt++) {
			yield* Effect.sleep("5 millis");
			seen = yield* stateOf(process);
		}
		return seen;
	});

describe("a command's bare port name reaches a process of its own program (#8898)", () => {
	it.live("lands on the only live process of the declaring program", () =>
		Effect.gen(function* () {
			const process = yield* spawnReviewer;
			yield* callReview(8898);
			const state = yield* settle(process);
			assert.deepStrictEqual(state.seen, [8898]);
		}).pipe(Effect.provide(kernel([reviewer]))),
	);

	it.live("lands on the caller's own process when the program has several", () =>
		Effect.gen(function* () {
			const first = yield* spawnReviewer;
			const second = yield* spawnReviewer;
			yield* callReview(8716, {...anonymous, process: second});
			const mine = yield* settle(second);
			assert.deepStrictEqual(mine.seen, [8716]);
			// The other one was not written to, which is the half a "send to all" reading would fail.
			assert.deepStrictEqual((yield* stateOf(first)).seen, []);
		}).pipe(Effect.provide(kernel([reviewer]))),
	);

	it.live(
		"refuses, naming the program and the ids, when several are live and the caller is none",
		() =>
			Effect.gen(function* () {
				yield* spawnReviewer;
				yield* spawnReviewer;
				const exit = yield* Effect.exit(callReview(8898));
				assert.isTrue(exit._tag === "Failure", "a call with no honest target should have refused");
				const refusal = exit._tag === "Failure" ? exit.cause.toString() : "";
				assert.include(refusal, "AmbiguousProcess");
				assert.include(refusal, reviewerId);
			}).pipe(Effect.provide(kernel([reviewer]))),
	);

	it.live("refuses when no process of the program is live", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(callReview(8898));
			assert.isTrue(exit._tag === "Failure", "a call with nothing live should have refused");
			assert.include(exit._tag === "Failure" ? exit.cause.toString() : "", "NoLiveProcess");
		}).pipe(Effect.provide(kernel([reviewer]))),
	);
});

/**
 * The launched half of the same resolution (#9230), which the ad-hoc cases above cannot show: a
 * process the *graph* stood up, not one `SpawnedProcesses.spawn` was asked for. `launch` enrols
 * every node it spawns in the same table `resolveOwnProcess` reads (#8944), so a compiled command's
 * bare `send` reaches a planned node exactly as it reaches an ad-hoc one. Before that enrolment the
 * resolution found the planned process and the delivery refused it.
 *
 * `it.live` for the reason the cases above are: the payload crosses the in-port's queue and pump
 * before the cell that owns it has run, so the assertion waits on a real clock, bounded.
 */
const reviewerNode = NodeId.make("reviewer-node");

/** One node and no routes — the shape a config plans a single standing program as. */
const plan: Graph = {nodes: [{id: reviewerNode, program: reviewerId, on: []}]};

describe("that bare port name reaches a process the graph launched (#9230)", () => {
	it.live("lands on the planned node, which the spell refused before it was enrolled", () =>
		Effect.gen(function* () {
			const compiled = yield* compile(plan);
			const services = yield* Effect.context<never>();
			const launched = yield* launch(compiled, yield* open(compiled), {services});
			const planned = launched.find((process) => process.node === reviewerNode);
			assert.isDefined(planned);

			yield* callReview(9230);

			const state = () => planned!.handle.getState() as State;
			for (let attempt = 0; attempt < 200 && state().seen.length === 0; attempt++) {
				yield* Effect.sleep("5 millis");
			}
			assert.deepStrictEqual(state().seen, [9230]);
		}).pipe(Effect.scoped, Effect.provide(kernel([reviewer]))),
	);
});
