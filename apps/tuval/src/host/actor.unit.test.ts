import {type DispatchDiscardedError, type NoCtx, subId} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Exit, Fiber, Schema, type Scope} from "effect";
import {expectTypeOf} from "vitest";
import {type ActorHandle, layer, make} from "./actor.ts";
import {type CoreMachine, defineActor} from "./definition.ts";
import type {ActorStoppedError, StoreError} from "./errors.ts";
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
			Boom | StoreError | DispatchDiscardedError | ActorStoppedError
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
});
