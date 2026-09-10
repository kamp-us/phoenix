import {type DispatchDiscardedError, type NoCtx, subId} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Exit, Fiber, Schema, type Scope} from "effect";
import {expectTypeOf} from "vitest";
import {type ActorHandle, layer, make} from "./actor.ts";
import {type CoreMachine, defineActor} from "./definition.ts";
import type {ActorStoppedError, MsgNotAcceptedError, StoreError} from "./errors.ts";
import {counterMachine, type Msg, recordingStore, type State} from "./fixtures.ts";

describe("host actor", () => {
	it.live("serializes interleaved dispatches through one Semaphore, in arrival order", () =>
		Effect.scoped(
			Effect.gen(function* () {
				type S = {readonly applied: readonly number[]};
				type M = {readonly type: "add"; readonly n: number};
				type C = {readonly type: "slow"; readonly n: number};
				const finished: number[] = [];
				const machine: CoreMachine<S, M, C, never, NoCtx> = {
					init: () => [{applied: []}, []],
					update: {
						add: (state, msg) => [{applied: [...state.applied, msg.n]}, [{type: "slow", n: msg.n}]],
					},
				};
				const actor = yield* make(
					defineActor({
						name: "test/serialized",
						machine,
						interpret: {
							slow: (cmd) =>
								Effect.sleep(`${6 - cmd.n} millis`).pipe(
									Effect.andThen(Effect.sync(() => void finished.push(cmd.n))),
								),
						},
						subscribe: {},
					}),
				);
				yield* Effect.all(
					[1, 2, 3, 4, 5].map((n) => actor.dispatchOnce({type: "add", n})),
					{concurrency: "unbounded"},
				);
				yield* actor.idle;
				assert.deepStrictEqual(actor.getState().applied, [1, 2, 3, 4, 5]);
				assert.deepStrictEqual(finished, [1, 2, 3, 4, 5]);
			}),
		),
	);

	it.effect("forks an Effect Sub into the scope and stops it when the scope closes", () =>
		Effect.gen(function* () {
			const events: string[] = [];
			type S = {readonly type: "off"} | {readonly type: "on"};
			type M = {readonly type: "toggle"};
			type U = {readonly id: ReturnType<typeof subId>; readonly type: "ticker"};
			const machine: CoreMachine<S, M, never, U, NoCtx> = {
				init: () => [{type: "off"}, []],
				update: {toggle: (state) => [{type: state.type === "off" ? "on" : "off"}, []]},
				subscriptions: (state) =>
					state.type === "on" ? [{id: subId("ticker"), type: "ticker"}] : [],
			};
			const definition = defineActor({
				name: "test/sub-scope",
				machine,
				interpret: {},
				subscribe: {
					ticker: () =>
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() => Effect.sync(() => void events.push("sub:stop")));
							events.push("sub:start");
							return yield* Effect.never;
						}),
				},
			});
			yield* Effect.scoped(
				Effect.gen(function* () {
					const actor = yield* make(definition);
					yield* actor.dispatch({type: "toggle"});
					assert.deepStrictEqual(events, ["sub:start"]);
				}),
			);
			assert.deepStrictEqual(events, ["sub:start", "sub:stop"]);

			events.length = 0;
			yield* Effect.scoped(
				Effect.gen(function* () {
					const actor = yield* make(definition);
					yield* actor.dispatch({type: "toggle"});
					yield* actor.dispatch({type: "toggle"});
					assert.deepStrictEqual(events, ["sub:start", "sub:stop"]);
				}),
			);
		}),
	);

	it.effect("provides the handle as a Layer whose scope owns the actor", () =>
		Effect.gen(function* () {
			const log: string[] = [];
			const saves: State[] = [];
			class Counter extends Context.Service<Counter, ActorHandle<State, Msg>>()("test/Counter") {}
			const live = layer(
				Counter,
				defineActor({
					name: "test/layered",
					machine: counterMachine(log),
					store: recordingStore(saves),
					interpret: {notify: () => Effect.succeed<Msg>({type: "acked"})},
					subscribe: {},
				}),
			);
			const handle = yield* Effect.gen(function* () {
				const counter = yield* Counter;
				yield* counter.dispatch({type: "start", runId: "r1"});
				yield* counter.dispatch({type: "tick"});
				return counter;
			}).pipe(Effect.provide(live));

			assert.deepStrictEqual(log, ["sub:start", "sub:stop"]);
			assert.deepStrictEqual(handle.getState(), {type: "running", runId: "r1", count: 1, acks: 1});
			const refused = yield* handle.dispatch({type: "tick"}).pipe(Effect.flip);
			assert.strictEqual(refused._tag, "tuval/host/ActorStoppedError");
		}),
	);

	it.effect("refuses a Msg with no cell and leaves the process open (#7973)", () =>
		Effect.scoped(
			Effect.gen(function* () {
				type S = {readonly count: number};
				// The wire shape a forwarded key arrives in. `Reducer` demands a cell per member of a
				// closed `M`, so the machine that meets this bug is one whose Msg type is open — which
				// is what a process handle erased to `AnyProgram` hands the shell's `forwardKey`.
				type M = {readonly type: string; readonly key?: string};
				const machine: CoreMachine<S, M, never, never, NoCtx> = {
					init: () => [{count: 0}, []],
					update: {tick: (state) => [{count: state.count + 1}, []]},
				};
				const actor = yield* make(
					defineActor({name: "test/no-cell", machine, interpret: {}, subscribe: {}}),
				);

				const refused = yield* actor.dispatch({type: "key", key: "x"}).pipe(Effect.flip);
				assert.strictEqual(refused._tag, "tuval/host/MsgNotAcceptedError");

				yield* actor.dispatch({type: "tick"});
				assert.deepStrictEqual(actor.getState(), {count: 1});
			}),
		),
	);

	it.effect("a cell that genuinely throws still closes the gate under the stop default", () =>
		Effect.scoped(
			Effect.gen(function* () {
				type S = {readonly count: number};
				type M = {readonly type: "tick"};
				const machine: CoreMachine<S, M, never, never, NoCtx> = {
					init: () => [{count: 0}, []],
					update: {
						tick: () => {
							throw new Error("boom");
						},
					},
				};
				const actor = yield* make(
					defineActor({name: "test/throwing-cell", machine, interpret: {}, subscribe: {}}),
				);

				const died = yield* Effect.exit(actor.dispatch({type: "tick"}));
				assert.isTrue(Exit.isFailure(died));

				const refused = yield* actor.dispatch({type: "tick"}).pipe(Effect.flip);
				assert.strictEqual(refused._tag, "tuval/host/ActorStoppedError");
			}),
		),
	);

	it.effect("keeps every save snapshot JSON-round-trippable", () =>
		Effect.gen(function* () {
			const saves: State[] = [];
			yield* Effect.scoped(
				Effect.gen(function* () {
					const actor = yield* make(
						defineActor({
							name: "test/snapshots",
							machine: counterMachine([]),
							store: recordingStore(saves),
							interpret: {notify: () => Effect.succeed<Msg>({type: "acked"})},
							subscribe: {},
						}),
					);
					yield* actor.dispatch({type: "start", runId: "r1"});
					yield* actor.dispatch({type: "tick"});
					assert.deepStrictEqual(JSON.parse(JSON.stringify(actor.getState())), actor.getState());
				}),
			);
			assert.isAbove(saves.length, 0);
			for (const snapshot of saves) {
				assert.deepStrictEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
			}
		}),
	);

	it("surfaces a handler's error and service requirements on the built actor", () => {
		class Boom extends Schema.TaggedError<Boom>()("test/Boom", {}) {}
		class Clock extends Context.Service<Clock, {readonly now: Effect.Effect<number>}>()(
			"test/Clock",
		) {}
		const definition = defineActor({
			name: "test/typed",
			machine: counterMachine([]),
			interpret: {
				notify: (cmd) =>
					Effect.gen(function* () {
						const clock = yield* Clock;
						if ((yield* clock.now) < cmd.count) return yield* new Boom({});
						return {type: "acked"} as const;
					}),
			},
			subscribe: {},
		});
		const built = make(definition);
		expectTypeOf<Effect.Error<typeof built>>().toEqualTypeOf<Boom | StoreError>();
		expectTypeOf<Effect.Services<typeof built>>().toEqualTypeOf<Clock | Scope.Scope>();
		expectTypeOf<Effect.Success<typeof built>>().toEqualTypeOf<ActorHandle<State, Msg, Boom>>();
		type Dispatched = ReturnType<Effect.Success<typeof built>["dispatch"]>;
		expectTypeOf<Effect.Error<Dispatched>>().toEqualTypeOf<
			Boom | StoreError | DispatchDiscardedError | ActorStoppedError | MsgNotAcceptedError
		>();
		expectTypeOf<Effect.Services<Dispatched>>().toEqualTypeOf<never>();
	});

	it.effect("onCommit runs once per commit, boot included, after that commit's Cmds", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const log: string[] = [];
				const actor = yield* make(
					defineActor({
						name: "test/commits",
						machine: counterMachine([]),
						interpret: {
							notify: (cmd) =>
								Effect.sync(() => {
									log.push(`notify:${cmd.count}`);
									return {type: "acked"} as const;
								}),
						},
						subscribe: {},
						onCommit: (state) => Effect.sync(() => void log.push(`commit:${state.type}`)),
					}),
				);
				assert.deepStrictEqual(log, ["commit:idle"]);
				yield* actor.dispatch({type: "start", runId: "r1"});
				yield* actor.dispatch({type: "tick"});
				assert.deepStrictEqual(log, [
					"commit:idle",
					"commit:running",
					"notify:1",
					"commit:running",
					"commit:running",
				]);
			}),
		),
	);

	it.live(
		"settles a follow-up interrupted before it ran, so a stop in the same tick completes",
		() =>
			Effect.gen(function* () {
				type S = {readonly followed: boolean};
				type M = {readonly type: "follow"};
				type C = {readonly type: "boot"};
				const machine: CoreMachine<S, M, C, never, NoCtx> = {
					init: () => [{followed: false}, [{type: "boot"}]],
					update: {follow: () => [{followed: true}, []]},
				};
				const definition = defineActor({
					name: "test/stop-in-the-same-tick",
					machine,
					interpret: {boot: () => Effect.succeed({type: "follow"} as const)},
					subscribe: {},
				});

				// The tick is the whole test: nothing is awaited between `make` returning and the scope
				// closing, so the boot's follow-up — forked into that same scope — is interrupted before
				// it ever starts. An in-body `ensuring` never registers on such a fiber, which leaves
				// `pending` above zero and hangs `stop` on `quiet` for ever; `addObserver` settles it on
				// the Exit instead (#7925).
				// Detached, so a regression hangs this assertion rather than the test fiber's own teardown.
				const running = yield* Effect.forkDetach(Effect.scoped(Effect.asVoid(make(definition))));
				const stopped = yield* Fiber.join(running).pipe(
					Effect.timeout("5 seconds"),
					Effect.exit,
					Effect.map(Exit.isSuccess),
				);
				assert.isTrue(
					stopped,
					"the actor's stop never completed: a pending follow-up never settled",
				);
			}),
	);

	describe("checkpointWorthy", () => {
		type Streaming = {readonly text: string; readonly partial: boolean};
		type Delta = {readonly type: "delta"; readonly chunk: string} | {readonly type: "done"};

		const streaming: CoreMachine<Streaming, Delta, never, never, NoCtx> = {
			init: (loaded) => [loaded ?? {text: "", partial: false}, []],
			update: {
				delta: (state, msg) => [{text: state.text + msg.chunk, partial: true}, []],
				done: (state) => [{...state, partial: false}, []],
			},
		};

		const streamer = (saves: Streaming[], name: string) =>
			make(
				defineActor({
					name,
					machine: streaming,
					store: recordingStore(saves),
					checkpointWorthy: (state) => !state.partial,
					interpret: {},
					subscribe: {},
				}),
			);

		it.effect("writes nothing mid-turn, and the Msg that ends the turn flushes", () =>
			Effect.scoped(
				Effect.gen(function* () {
					const saves: Streaming[] = [];
					const actor = yield* streamer(saves, "test/worthy-flush");
					assert.deepStrictEqual(saves, [{text: "", partial: false}]);

					for (const chunk of ["a", "b", "c", "d"]) {
						yield* actor.dispatch({type: "delta", chunk});
					}
					assert.strictEqual(saves.length, 1);

					yield* actor.dispatch({type: "done"});
					// Asserted after the dispatch returns, which is the flush claim: the turn cannot be
					// reported done while its own state is still only in memory.
					assert.deepStrictEqual(saves, [
						{text: "", partial: false},
						{text: "abcd", partial: false},
					]);
				}),
			),
		);

		it.effect("stops without writing the partial a turn cut short left in state", () =>
			Effect.gen(function* () {
				const saves: Streaming[] = [];
				yield* Effect.scoped(
					Effect.gen(function* () {
						const actor = yield* streamer(saves, "test/worthy-stop-mid-turn");
						yield* actor.dispatch({type: "delta", chunk: "half"});
						assert.deepStrictEqual(actor.getState(), {text: "half", partial: true});
					}),
				);
				assert.deepStrictEqual(saves, [{text: "", partial: false}]);
			}),
		);

		it.effect("still writes the boot save and the stop-path save when the state is worthy", () =>
			Effect.gen(function* () {
				const saves: Streaming[] = [];
				yield* Effect.scoped(
					Effect.gen(function* () {
						const actor = yield* streamer(saves, "test/worthy-boot-and-stop");
						yield* actor.dispatch({type: "delta", chunk: "hi"});
						yield* actor.dispatch({type: "done"});
					}),
				);
				assert.deepStrictEqual(saves, [
					{text: "", partial: false},
					{text: "hi", partial: false},
					{text: "hi", partial: false},
				]);
			}),
		);

		it.effect("saves every state when the definition declares no predicate", () =>
			Effect.scoped(
				Effect.gen(function* () {
					const saves: State[] = [];
					const actor = yield* make(
						defineActor({
							name: "test/worthy-absent",
							machine: counterMachine([]),
							store: recordingStore(saves),
							interpret: {notify: () => Effect.succeed<Msg>({type: "acked"})},
							subscribe: {},
						}),
					);
					yield* actor.dispatch({type: "start", runId: "r1"});
					yield* actor.dispatch({type: "tick"});
					assert.deepStrictEqual(saves, [
						{type: "idle", count: 0},
						{type: "running", runId: "r1", count: 0, acks: 0},
						{type: "running", runId: "r1", count: 1, acks: 0},
						{type: "running", runId: "r1", count: 1, acks: 1},
					]);
				}),
			),
		);
	});
});
