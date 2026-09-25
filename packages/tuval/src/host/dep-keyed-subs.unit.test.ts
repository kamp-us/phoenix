/** The host's one Sub path: `{type, deps}` entries, each run by the runner of its type. */

import type {NoCtx, Sub} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import type {ProgramCore} from "../registry/program.ts";
import {make} from "./actor.ts";
import {defineActor} from "./definition.ts";
import {MissingSubRunnerError} from "./errors.ts";

type Slot = string | null;
type State = {readonly a: Slot; readonly b: Slot; readonly broken: boolean};
type Msg =
	| {readonly type: "a"; readonly to: Slot}
	| {readonly type: "b"; readonly to: Slot}
	| {readonly type: "break"}
	| {readonly type: "noop"};
type Run = Sub<"run", {readonly key: string}>;

const off: State = {a: null, b: null, broken: false};

const keyed = (slot: Slot) => (slot === null ? null : {key: slot});

/** A runner that logs its start and, when its scope closes, its stop — each under its deps key. */
const logging = (log: string[]) => ({
	run: (sub: Run) =>
		Effect.acquireRelease(
			Effect.sync(() => void log.push(`start:${sub.deps.key}`)),
			() => Effect.sync(() => void log.push(`stop:${sub.deps.key}`)),
		).pipe(Effect.andThen(Effect.never)),
});

type Machine = ProgramCore<State, Msg, never, Run, NoCtx>;

const machineOf = (subs: Machine["subs"]): Machine => ({
	init: () => [off, []],
	update: {
		a: (state, msg) => [{...state, a: msg.to}, []],
		b: (state, msg) => [{...state, b: msg.to}, []],
		break: (state) => [{...state, broken: true}, []],
		noop: (state) => [state, []],
	},
	subs,
});

describe("dep-keyed Subs", () => {
	it.effect(
		"start when deps turn on, hold while they hold, restart on new deps, stop on null",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const log: string[] = [];
					const actor = yield* make(
						defineActor({
							name: "dep-keyed/lifecycle",
							machine: machineOf([{type: "run", deps: (state) => keyed(state.a)}]),
							interpret: {},
							subscribe: logging(log),
						}),
					);
					assert.deepStrictEqual(log, []);

					yield* actor.dispatch({type: "a", to: "x"});
					assert.deepStrictEqual(log, ["start:x"]);

					yield* actor.dispatch({type: "noop"});
					yield* actor.dispatch({type: "a", to: "x"});
					assert.deepStrictEqual(log, ["start:x"]);

					yield* actor.dispatch({type: "a", to: "y"});
					assert.deepStrictEqual(log, ["start:x", "stop:x", "start:y"]);

					yield* actor.dispatch({type: "a", to: null});
					assert.deepStrictEqual(log, ["start:x", "stop:x", "start:y", "stop:y"]);
				}),
			),
	);

	it.effect("runs two runners for two entries of one type with different deps", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const log: string[] = [];
				const actor = yield* make(
					defineActor({
						name: "dep-keyed/two-of-a-type",
						machine: machineOf([
							{type: "run", deps: (state) => keyed(state.a)},
							{type: "run", deps: (state) => keyed(state.b)},
						]),
						interpret: {},
						subscribe: logging(log),
					}),
				);
				yield* actor.dispatch({type: "a", to: "x"});
				yield* actor.dispatch({type: "b", to: "y"});
				assert.deepStrictEqual(log, ["start:x", "start:y"]);

				yield* actor.dispatch({type: "a", to: null});
				assert.deepStrictEqual(log, ["start:x", "start:y", "stop:x"]);
			}),
		),
	);

	it.effect("leaves a type's running Subs standing when an entry of that type throws", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const log: string[] = [];
				const actor = yield* make(
					defineActor({
						name: "dep-keyed/throwing-deps",
						machine: machineOf([
							{
								type: "run",
								deps: (state) => {
									// biome-ignore lint/plugin: a pure `deps` throwing is the user-code fault under test, not Effect code
									if (state.broken) throw new Error("deps threw");
									return keyed(state.a);
								},
							},
						]),
						interpret: {},
						subscribe: logging(log),
						supervision: "escalate",
					}),
				);
				yield* actor.dispatch({type: "a", to: "x"});
				const died = yield* Effect.exit(actor.dispatch({type: "break"}));
				assert.isTrue(Exit.isFailure(died));
				assert.deepStrictEqual(log, ["start:x"]);
			}),
		),
	);

	it.effect("refuses a Sub type the definition has no runner for", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const actor = yield* make(
					defineActor({
						name: "dep-keyed/no-runner",
						machine: machineOf([{type: "run", deps: (state) => keyed(state.a)}]),
						interpret: {},
						subscribe: {} as ReturnType<typeof logging>,
					}),
				);
				const cause = yield* actor.dispatch({type: "a", to: "x"}).pipe(Effect.sandbox, Effect.flip);
				assert.instanceOf(Cause.squash(cause), MissingSubRunnerError);
			}),
		),
	);
});
