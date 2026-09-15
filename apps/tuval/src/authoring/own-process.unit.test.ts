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
import {Effect, Layer, Option, Schema} from "effect";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {ClientId, type Scope, WorkspaceId} from "../commands/spell.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import type {ProcessId} from "../process/process.ts";
import {type AnyProgram, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {defineProgram} from "./define-program.ts";
import {send} from "./effect.ts";
import {port} from "./port.ts";

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
