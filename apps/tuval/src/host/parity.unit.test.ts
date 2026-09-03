import {run, type Store} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Schema} from "effect";
import {make} from "./actor.ts";
import {defineActor} from "./definition.ts";
import {toDemlikMachine} from "./demlik-bridges.ts";
import {ActorStoppedError} from "./errors.ts";
import {counterMachine, type Msg, recordingStore, type State} from "./fixtures.ts";

interface Run {
	readonly states: State[];
	readonly saves: State[];
	readonly log: string[];
	readonly afterStop: unknown;
}

const script: readonly Msg[] = [
	{type: "start", runId: "r1"},
	{type: "tick"},
	{type: "tick"},
	{type: "halt"},
];

const definitionFor = (log: string[], store: Store<State>) =>
	defineActor({
		machine: counterMachine(log),
		store,
		interpret: {
			notify: (cmd) =>
				Effect.sync((): Msg => {
					log.push(`notify:${cmd.count}`);
					return {type: "acked"};
				}),
		},
		subscribe: {},
	});

const throughHost = Effect.scoped(
	Effect.gen(function* () {
		const log: string[] = [];
		const saves: State[] = [];
		const actor = yield* make(definitionFor(log, recordingStore(saves)));
		const states: State[] = [];
		for (const msg of script) {
			yield* actor.dispatch(msg);
			states.push(actor.getState());
		}
		yield* actor.stop;
		const afterStop = yield* actor.dispatch({type: "tick"}).pipe(Effect.flip);
		return {states, saves, log, afterStop} satisfies Run;
	}),
);

/** Demlik's own `run` is Promise-native; a rejection anywhere in its script fails the parity run. */
class DemlikRunFailed extends Schema.TaggedError<DemlikRunFailed>()("test/DemlikRunFailed", {
	cause: Schema.Defect(),
}) {}

const throughDemlik = Effect.tryPromise({
	try: async (): Promise<Run> => {
		const log: string[] = [];
		const saves: State[] = [];
		const store = recordingStore(saves);
		const runtime = await run(toDemlikMachine(definitionFor(log, store), Context.empty()), {store})
			.ready;
		const states: State[] = [];
		for (const msg of script) {
			await runtime.dispatch(msg);
			states.push(runtime.getState());
		}
		await runtime.stop();
		const afterStop = await runtime.dispatch({type: "tick"}).then(
			() => undefined,
			(error: unknown) => error,
		);
		return {states, saves, log, afterStop};
	},
	catch: (cause) => new DemlikRunFailed({cause}),
});

describe("host parity with Demlik's run", () => {
	it.effect("one machine, both hosts: equal states, saves, Sub lifecycle and stop gate", () =>
		Effect.gen(function* () {
			const host = yield* throughHost;
			const demlik = yield* throughDemlik;

			assert.deepStrictEqual(host.states, demlik.states);
			assert.deepStrictEqual(host.saves, demlik.saves);
			assert.deepStrictEqual(host.log, demlik.log);

			assert.lengthOf(
				host.log.filter((entry) => entry === "sub:start"),
				1,
			);
			assert.lengthOf(
				host.log.filter((entry) => entry === "sub:stop"),
				1,
			);

			assert.deepStrictEqual(host.states.at(-1), {type: "idle", count: 2});
			assert.instanceOf(host.afterStop, ActorStoppedError);
			assert.instanceOf(demlik.afterStop, Error);
			assert.match((demlik.afterStop as Error).message, /runtime stopped/);
		}),
	);
});
