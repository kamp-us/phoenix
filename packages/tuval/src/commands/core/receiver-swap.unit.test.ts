/**
 * A swapped process's in-ports switch with it (#9823): after `Processes.swap` a payload on an in-port
 * goes through the reloaded row's receiver, whether `SpawnedProcesses.spawn` or `adopt` wired the
 * port, and the process keeps its state and every payload queued before the swap.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Fiber, Latch, Layer, Option, Queue} from "effect";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {memoryStores} from "../../durability/stores.ts";
import {ProcessPorts} from "../../ports/ProcessPorts.ts";
import {ReceiverMissing} from "../../process/errors.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessId} from "../../process/process.ts";
import {type AnyProgram, type Program, ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {SpawnedProcesses} from "./process.ts";

type EarState = {readonly heard: ReadonlyArray<string>};
type Hear = {readonly type: "hear"; readonly word: string};
type Hold = {readonly type: "hold"};

const EAR = ProgramId.make("ear");
const isWord = (payload: unknown): payload is string => typeof payload === "string";

/**
 * What a `hold` Cmd waits on. A `gate` payload folds into one, so the process sits inside that
 * fold, holding its dispatch permit, until the test opens it — the window payloads queue in.
 */
let gate: Latch.Latch = Latch.makeUnsafe(true);

/**
 * One in-port and a list of what it heard. Only the receiver differs between the rows a test swaps
 * between: each stamps the word it makes with its own tag, so the state names which receiver ran.
 */
const ear = (tag: string, receives = true): AnyProgram =>
	({
		id: EAR,
		core: defineMachine<EarState, Hear, Hold, never, unknown>({
			init: (loaded) => [loaded ?? {heard: []}, []],
			update: {
				hear: (state, msg) => [
					{heard: [...state.heard, msg.word]},
					msg.word.endsWith(":gate") ? [{type: "hold"}] : [],
				],
			},
		}),
		ports: {
			words: {
				kind: "text/v1",
				direction: "in",
				accepts: isWord,
				bound: {capacity: 8, overflow: "suspend"},
			},
		},
		...(receives
			? {receive: {words: (word: string): Hear => ({type: "hear", word: `${tag}:${word}`})}}
			: {}),
		handlers: {
			hold: () =>
				Effect.as(
					Effect.suspend(() => gate.await),
					[] as ReadonlyArray<Hear>,
				),
		},
		capabilities: [],
		identity: {package: "@kampus/tuval", program: "ear", version: "1.0.0", digest: "sha256:ear"},
		placement: {host: "local"},
	}) satisfies Program<EarState, Hear, Hold, never, unknown, never, never>;

const kernel = () =>
	SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
		Layer.provideMerge(Processes.layer),
		Layer.provideMerge(
			Layer.mergeAll(Registry.layer([ear("v1")]), Checkpoints.layer(memoryStores())),
		),
	);

/** The pumps are forked fibers a `send` does not wait on, so a test waits for the fold it expects. */
const heardBy = (id: ProcessId, count: number) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		const handle = Option.getOrThrow(yield* processes.handle(id));
		const heard = () => (handle.getState() as EarState).heard;
		for (let attempt = 0; attempt < 400 && heard().length < count; attempt++) {
			yield* Effect.sleep("5 millis");
		}
		return heard();
	});

const viaSpawn = Effect.flatMap(SpawnedProcesses, (spawned) => spawned.spawn(EAR, Option.none()));

const viaAdopt = Effect.gen(function* () {
	const spawned = yield* SpawnedProcesses;
	const processes = yield* Processes;
	const id = ProcessId.make("adopted-ear");
	const queue = yield* Queue.make<unknown>({capacity: 8, strategy: "suspend"});
	yield* spawned.adopt({
		process: id,
		program: ear("v1"),
		inboxes: new Map([["words", queue]]),
		parent: Option.none(),
		emit: () => Effect.succeed([]),
		start: (ports) => processes.spawn(EAR, {id, services: Context.make(ProcessPorts, ports)}),
	});
	return id;
});

const send = (id: ProcessId, word: string) =>
	Effect.flatMap(SpawnedProcesses, (spawned) => spawned.send(id, "words", word));

for (const [path, start] of [
	["spawn", viaSpawn],
	["adopt", viaAdopt],
] as const) {
	describe(`a process wired through SpawnedProcesses.${path}, swapped onto a reloaded row`, () => {
		it.live("translates an in-port payload with the reloaded receiver, keeping its state", () =>
			Effect.gen(function* () {
				const processes = yield* Processes;
				const id = yield* start;
				yield* send(id, "one");
				assert.deepStrictEqual(yield* heardBy(id, 1), ["v1:one"]);

				assert.strictEqual(yield* processes.swap(id, ear("v2")), "switched");
				yield* send(id, "two");

				assert.deepStrictEqual(yield* heardBy(id, 2), ["v1:one", "v2:two"]);
			}).pipe(Effect.scoped, Effect.provide(kernel())),
		);

		it.live("drops no payload queued while the swap waited for the fold in flight", () =>
			Effect.gen(function* () {
				const processes = yield* Processes;
				const id = yield* start;
				gate = yield* Latch.make(false);
				yield* send(id, "gate");
				yield* heardBy(id, 1);
				// The pump is inside the gate's fold, so these queue behind it and the swap waits on it.
				yield* send(id, "a");
				yield* send(id, "b");
				const swapping = yield* Effect.forkChild(processes.swap(id, ear("v2")));
				yield* gate.open;
				assert.strictEqual(yield* Fiber.join(swapping), "switched");
				yield* send(id, "c");

				const heard = yield* heardBy(id, 4);
				assert.deepStrictEqual(heard.slice(0, 1), ["v1:gate"]);
				// Which receiver translated `a` and `b` turns on whether the pump or the swap took the
				// permit first once the gate opened; that none of them was lost does not.
				assert.deepStrictEqual(
					heard.slice(1, 3).map((word) => word.split(":")[1]),
					["a", "b"],
				);
				assert.deepStrictEqual(heard.slice(3), ["v2:c"]);
			}).pipe(Effect.scoped, Effect.provide(kernel())),
		);
	});
}

describe("ProcessHandle.receive", () => {
	it.effect(
		"refuses a port the row it runs now gives no receiver, rather than using the old one",
		() =>
			Effect.gen(function* () {
				const processes = yield* Processes;
				const handle = yield* processes.spawn(EAR, {services: Context.empty()});
				yield* handle.receive("words", "one");
				yield* processes.swap(handle.id, ear("v2", false));

				const refused = yield* Effect.flip(handle.receive("words", "two"));
				assert.deepStrictEqual(
					refused,
					new ReceiverMissing({id: handle.id, programId: EAR, port: "words"}),
				);
				assert.deepStrictEqual((handle.getState() as EarState).heard, ["v1:one"]);
			}).pipe(Effect.scoped, Effect.provide(kernel())),
	);
});
