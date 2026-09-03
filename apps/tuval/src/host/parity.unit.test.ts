import {run, type Store} from "@demlik/tea";
import {Context, Effect} from "effect";
import {describe, expect, it} from "vitest";
import {ActorStoppedError, make} from "./actor.ts";
import {defineActor} from "./definition.ts";
import {toDemlikMachine} from "./demlik-bridges.ts";
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

const throughDemlik = async (): Promise<Run> => {
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
};

describe("host parity with Demlik's run", () => {
	it("one machine, both hosts: equal states, saves, Sub lifecycle and stop gate", async () => {
		const host = await Effect.runPromise(throughHost);
		const demlik = await throughDemlik();

		expect(host.states).toEqual(demlik.states);
		expect(host.saves).toEqual(demlik.saves);
		expect(host.log).toEqual(demlik.log);

		expect(host.log.filter((entry) => entry === "sub:start")).toHaveLength(1);
		expect(host.log.filter((entry) => entry === "sub:stop")).toHaveLength(1);

		expect(host.states.at(-1)).toEqual({type: "idle", count: 2});
		expect(host.afterStop).toBeInstanceOf(ActorStoppedError);
		expect(demlik.afterStop).toBeInstanceOf(Error);
		expect((demlik.afterStop as Error).message).toMatch(/runtime stopped/);
	});
});
