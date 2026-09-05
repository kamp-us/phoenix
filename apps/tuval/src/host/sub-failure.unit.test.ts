/** The ADR 0346 Sub-failure policy and the definition name, branch by branch. */

import {type DepKeyedSub, type NoCtx, type SubId, subId} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Schema, Scope} from "effect";
import {make} from "./actor.ts";
import {type CoreMachine, defineActor, type HostErrorPhase, type OnError} from "./definition.ts";
import {subDisposerBridge} from "./demlik-bridges.ts";
import {counterMachine} from "./fixtures.ts";

class Boom extends Schema.TaggedError<Boom>()("test/Boom", {}) {}

type State = {readonly armed: boolean; readonly seen: readonly string[]};
type Msg = {readonly type: "arm"} | {readonly type: "noted"; readonly note: string};
type Ticker = {readonly id: SubId; readonly type: "ticker"};

const TICKER: Ticker = {id: subId("ticker"), type: "ticker"};

const machineWith = (
	subFailure?: CoreMachine<State, Msg, never, Ticker, NoCtx>["subFailure"],
): CoreMachine<State, Msg, never, Ticker, NoCtx> => ({
	init: () => [{armed: false, seen: []}, []],
	update: {
		arm: (state: State) => [{...state, armed: true}, []],
		noted: (state: State, msg: Extract<Msg, {type: "noted"}>) => [
			{...state, seen: [...state.seen, msg.note]},
			[],
		],
	},
	subscriptions: (state) => (state.armed ? [TICKER] : []),
	...(subFailure === undefined ? {} : {subFailure}),
});

type Reported = {readonly error: unknown; readonly phase: HostErrorPhase};

const recordingOnError =
	(into: Reported[]): OnError =>
	(error, context) =>
		Effect.sync(() => void into.push({error, phase: context.phase}));

/** The policy runs on a detached fiber, so a dispatch's own quiescence does not cover it. */
const settle = Effect.sleep("20 millis");

describe("Sub-failure policy", () => {
	it.live("reports the Cause under sub-fiber, then hands subFailure's Msg to the reducer", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const reported: Reported[] = [];
				let opened = 0;
				const actor = yield* make(
					defineActor({
						name: "sub-failure/addressed",
						machine: machineWith((sub, failure) => ({
							type: "noted",
							note: `${sub.type}:${failure.reason}:${failure.id}`,
						})),
						interpret: {},
						subscribe: {
							ticker: () =>
								Effect.suspend(() => {
									opened++;
									return new Boom({});
								}),
						},
						onError: recordingOnError(reported),
					}),
				);
				yield* actor.dispatch({type: "arm"});
				yield* settle;
				yield* actor.idle;

				assert.deepStrictEqual(
					reported.map((entry) => entry.phase),
					["sub-fiber"],
				);
				assert.instanceOf(reported[0]?.error, Boom);
				assert.deepStrictEqual(actor.getState().seen, ["ticker:failure:ticker"]);
				// Still desired, and still not re-armed: the same id is the same lifetime.
				yield* actor.dispatch({type: "arm"});
				yield* settle;
				assert.strictEqual(opened, 1);
			}),
		),
	);

	it.live("closes the process Scope with the failure as its Exit when nothing addresses it", () =>
		Effect.gen(function* () {
			const reported: Reported[] = [];
			const exits: Array<Exit.Exit<unknown, unknown>> = [];
			const scope = yield* Scope.make();
			yield* Scope.addFinalizerExit(scope, (exit) => Effect.sync(() => void exits.push(exit)));
			const actor = yield* make(
				defineActor({
					name: "sub-failure/unaddressed",
					machine: machineWith(),
					interpret: {},
					subscribe: {ticker: () => new Boom({})},
					onError: recordingOnError(reported),
				}),
			).pipe(Effect.provideService(Scope.Scope, scope));

			yield* actor.dispatch({type: "arm"});
			yield* settle;

			assert.lengthOf(exits, 1);
			const failed = exits.filter(Exit.isFailure);
			assert.lengthOf(failed, 1);
			for (const exit of failed) assert.instanceOf(Cause.squash(exit.cause), Boom);
			const refused = yield* actor.dispatch({type: "arm"}).pipe(Effect.flip);
			assert.strictEqual(refused._tag, "tuval/host/ActorStoppedError");
		}),
	);

	it.live("reports a throwing subFailure as UserCodeThrew and takes the unaddressed branch", () =>
		Effect.gen(function* () {
			const reported: Reported[] = [];
			const exits: Array<Exit.Exit<unknown, unknown>> = [];
			const scope = yield* Scope.make();
			yield* Scope.addFinalizerExit(scope, (exit) => Effect.sync(() => void exits.push(exit)));
			yield* make(
				defineActor({
					name: "sub-failure/throwing-policy",
					machine: machineWith(() => {
						// biome-ignore lint/plugin: the throw is the subject — this is the user-code-threw branch.
						throw new Error("the policy itself broke");
					}),
					interpret: {},
					subscribe: {ticker: () => new Boom({})},
					onError: recordingOnError(reported),
				}),
			).pipe(
				Effect.provideService(Scope.Scope, scope),
				Effect.flatMap((actor) => actor.dispatch({type: "arm"})),
			);
			yield* settle;

			assert.deepStrictEqual(
				reported.map((entry) => entry.phase),
				["sub-fiber", "sub-fiber"],
			);
			assert.instanceOf(reported[0]?.error, Boom);
			assert.strictEqual(
				(reported[1]?.error as {readonly _tag?: string})._tag,
				"tuval/host/UserCodeThrew",
			);
			assert.lengthOf(exits, 1);
		}),
	);

	it.live("marks a Sub that completes normally ended, sends no Msg, and never re-arms it", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const reported: Reported[] = [];
				let opened = 0;
				const actor = yield* make(
					defineActor({
						name: "sub-failure/ended",
						machine: machineWith(() => ({type: "noted", note: "should not happen"})),
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
							name: "sub-failure/quiet-teardown",
							machine: machineWith(),
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

	it.effect("holds a dep-keyed Sub's fiber open, so its error channel is live after the open", () =>
		Effect.gen(function* () {
			const log: string[] = [];
			const sub: DepKeyedSub<null, never, NoCtx> = {
				deps: () => ({}),
				source: () => {
					log.push("open");
					return () => void log.push("dispose");
				},
			};
			const scope = yield* Scope.make();
			const fiber = yield* Effect.forkIn(
				subDisposerBridge(sub, null, () => {}, {}).pipe(Effect.provideService(Scope.Scope, scope)),
				scope,
				{startImmediately: true},
			);

			assert.deepStrictEqual(log, ["open"]);
			assert.isUndefined(fiber.pollUnsafe());
			yield* Scope.close(scope, Exit.void);
			assert.deepStrictEqual(log, ["open", "dispose"]);
		}),
	);

	it("refuses a definition name this process has already seen", () => {
		const build = () =>
			defineActor({
				name: "sub-failure/duplicate",
				machine: counterMachine([]),
				interpret: {notify: () => Effect.void},
				subscribe: {},
			});
		build();
		assert.throws(build, /already defined/);
	});
});
