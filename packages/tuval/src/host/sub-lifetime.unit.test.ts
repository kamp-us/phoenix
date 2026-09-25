/** A Sub's lifetime on the host (ADR 0408), and the definition name. */

import type {NoCtx} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Schema, Scope, Stream} from "effect";
import {type Sub, subIdOf} from "../registry/sub.ts";
import {make} from "./actor.ts";
import {type CoreMachine, defineActor, type HostErrorPhase, type OnError} from "./definition.ts";
import {disposerStream} from "./demlik-bridges.ts";
import {counterMachine, counterSubscribe} from "./fixtures.ts";

class Boom extends Schema.TaggedError<Boom>()("test/Boom", {}) {}

type State = {readonly armed: boolean; readonly seen: readonly string[]};
type Msg = {readonly type: "arm"} | {readonly type: "noted"; readonly note: string};
type Ticker = Sub<"ticker", true>;

const machine: CoreMachine<State, Msg, never, Ticker, NoCtx> = {
	init: () => [{armed: false, seen: []}, []],
	update: {
		arm: (state: State) => [{...state, armed: true}, []],
		noted: (state: State, msg: Extract<Msg, {type: "noted"}>) => [
			{...state, seen: [...state.seen, msg.note]},
			[],
		],
	},
	subs: [{type: "ticker", deps: (state) => (state.armed ? true : null)}],
};

type Reported = {readonly error: unknown; readonly phase: HostErrorPhase};

const recordingOnError =
	(into: Reported[]): OnError =>
	(error, context) =>
		Effect.sync(() => void into.push({error, phase: context.phase}));

/** A Sub's exit is observed on a detached fiber, so a dispatch's own quiescence does not cover it. */
const settle = Effect.sleep("20 millis");

describe("Sub lifetime", () => {
	it.live("hands a Msg the Sub mapped from its own error to update, and keeps running", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const reported: Reported[] = [];
				const actor = yield* make(
					defineActor({
						name: "sub-lifetime/mapped",
						machine,
						interpret: {},
						subscribe: {
							ticker: (_sub, _ctx, dispatch) =>
								new Boom({}).pipe(
									Effect.catchTag("test/Boom", () =>
										Effect.sync(() => dispatch({type: "noted", note: "ticker failed"})),
									),
								),
						},
						onError: recordingOnError(reported),
					}),
				);
				yield* actor.dispatch({type: "arm"});
				yield* settle;
				yield* actor.idle;

				assert.deepStrictEqual(reported, []);
				assert.deepStrictEqual(actor.getState().seen, ["ticker failed"]);
				yield* actor.dispatch({type: "noted", note: "still running"});
				assert.deepStrictEqual(actor.getState().seen, ["ticker failed", "still running"]);
			}),
		),
	);

	it.live(
		"closes the process Scope with an unmapped failure as its Exit, then refuses dispatch",
		() =>
			Effect.gen(function* () {
				const reported: Reported[] = [];
				const exits: Array<Exit.Exit<unknown, unknown>> = [];
				const scope = yield* Scope.make();
				yield* Scope.addFinalizerExit(scope, (exit) => Effect.sync(() => void exits.push(exit)));
				const actor = yield* make(
					defineActor({
						name: "sub-lifetime/unmapped",
						machine,
						interpret: {},
						subscribe: {ticker: () => new Boom({})},
						onError: recordingOnError(reported),
					}),
				).pipe(Effect.provideService(Scope.Scope, scope));

				yield* actor.dispatch({type: "arm"});
				yield* settle;

				assert.deepStrictEqual(
					reported.map((entry) => entry.phase),
					["sub-fiber"],
				);
				assert.instanceOf(reported[0]?.error, Boom);
				assert.lengthOf(exits, 1);
				const failed = exits.filter(Exit.isFailure);
				assert.lengthOf(failed, 1);
				for (const exit of failed) assert.instanceOf(Cause.squash(exit.cause), Boom);
				const refused = yield* actor.dispatch({type: "arm"}).pipe(Effect.flip);
				assert.strictEqual(refused._tag, "tuval/host/ActorStoppedError");
			}),
	);

	it.live("marks a Sub that completes normally ended, sends no Msg, and never re-arms it", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const reported: Reported[] = [];
				let opened = 0;
				const actor = yield* make(
					defineActor({
						name: "sub-lifetime/ended",
						machine,
						interpret: {},
						subscribe: {
							ticker: () => Effect.sync(() => void opened++),
						},
						onError: recordingOnError(reported),
					}),
				);
				yield* actor.dispatch({type: "arm"});
				yield* settle;
				yield* actor.dispatch({type: "arm"});
				yield* settle;
				yield* actor.idle;

				assert.strictEqual(opened, 1);
				assert.deepStrictEqual(actor.getState().seen, []);
				assert.deepStrictEqual(reported, []);
			}),
		),
	);

	it.live("says nothing on a clean teardown: an interruption-only cause is not a failure", () =>
		Effect.gen(function* () {
			const reported: Reported[] = [];
			yield* Effect.scoped(
				Effect.gen(function* () {
					const actor = yield* make(
						defineActor({
							name: "sub-lifetime/quiet-teardown",
							machine,
							interpret: {},
							subscribe: {ticker: () => Effect.never},
							onError: recordingOnError(reported),
						}),
					);
					yield* actor.dispatch({type: "arm"});
				}),
			);
			yield* settle;
			assert.deepStrictEqual(reported, []);
		}),
	);

	it.effect(
		"holds a disposer runner's Stream open until it is interrupted, then runs the dispose",
		() =>
			Effect.gen(function* () {
				const log: string[] = [];
				const runner = disposerStream<Ticker, never>(() => {
					log.push("open");
					return () => void log.push("dispose");
				});
				const sub: Ticker = {id: subIdOf("ticker", true), type: "ticker", deps: true};
				const scope = yield* Scope.make();
				const fiber = yield* Effect.forkIn(Stream.runDrain(runner(sub)), scope, {
					startImmediately: true,
				});
				yield* Effect.yieldNow;

				assert.deepStrictEqual(log, ["open"]);
				assert.isUndefined(fiber.pollUnsafe());
				yield* Scope.close(scope, Exit.void);
				assert.deepStrictEqual(log, ["open", "dispose"]);
			}),
	);

	it("refuses a definition name this process has already seen", () => {
		const build = () =>
			defineActor({
				name: "sub-lifetime/duplicate",
				machine: counterMachine(),
				interpret: {notify: () => Effect.void},
				subscribe: counterSubscribe([]),
			});
		build();
		assert.throws(build, /already defined/);
	});
});
