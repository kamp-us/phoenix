/**
 * ADR 0408 through a registry row: a row's own Sub handler maps the errors it expects into Msgs, and
 * a failure it lets escape stops the process. `host/sub-lifetime.unit.test.ts` covers the host alone.
 */

import {type Cmd, type Sub, subId} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Schema} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {
	type AnyProgram,
	type HostSubs,
	type Program,
	type ProgramCore,
	ProgramId,
} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {Processes} from "./Processes.ts";
import type {ProcessTable} from "./ProcessTable.ts";

class Boom extends Schema.TaggedError<Boom>()("test/Boom", {}) {}

type State = {readonly armed: boolean; readonly seen: ReadonlyArray<string>};
type Msg = {readonly type: "arm"} | {readonly type: "noted"; readonly note: string};
type Ticker = Sub<"ticker">;

const TICKER: Ticker = {id: subId("ticker"), type: "ticker"};

const core: ProgramCore<State, Msg, Cmd<never>, Ticker, unknown> = {
	init: (loaded) => [loaded ?? {armed: false, seen: []}, []],
	update: {
		arm: (state: State) => [{...state, armed: true}, []],
		noted: (state: State, msg: Extract<Msg, {type: "noted"}>) => [
			{...state, seen: [...state.seen, msg.note]},
			[],
		],
	},
	subscriptions: (state) => (state.armed ? [TICKER] : []),
	// Demlik's `Machine` demands a cell beside the row's `subs`; the row's Effect handler wins (#7576).
	subscribe: {ticker: () => () => {}},
};

const rowWith = (id: string, subs: HostSubs<Msg, Ticker, Boom, never>): AnyProgram =>
	({
		id: ProgramId.make(id),
		core,
		ports: {},
		handlers: {},
		subs,
		capabilities: [],
		identity: {package: "@kampus/tuval", program: id, version: "1.0.0", digest: `sha256:${id}`},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Cmd<never>, Ticker, unknown, Boom, never>;

const withKernel = <A, E>(
	rows: ReadonlyArray<AnyProgram>,
	body: Effect.Effect<A, E, Processes | ProcessTable>,
) =>
	body.pipe(
		Effect.provide(
			Processes.layer.pipe(
				Layer.provide([Registry.layer(rows), Checkpoints.layer(memoryStores())]),
			),
		),
	);

/** A Sub runs on its own fiber, so a dispatch's own quiescence does not cover its failure. */
const settle = Effect.sleep("20 millis");

describe("a program row's Sub errors", () => {
	it.live("keeps the process running when the Sub maps its own error into a Msg", () =>
		Effect.scoped(
			withKernel(
				[
					rowWith("mapped", {
						ticker: (_sub, dispatch) =>
							new Boom({}).pipe(
								Effect.catchTag("test/Boom", () =>
									Effect.sync(() => dispatch({type: "noted", note: "ticker failed"})),
								),
							),
					}),
				],
				Effect.gen(function* () {
					const processes = yield* Processes;
					const handle = yield* processes.spawn(ProgramId.make("mapped"), {
						services: Context.empty(),
					});
					yield* handle.dispatch({type: "arm"});
					yield* settle;

					assert.deepStrictEqual((handle.getState() as State).seen, ["ticker failed"]);
					yield* handle.dispatch({type: "noted", note: "still running"});
					assert.deepStrictEqual((handle.getState() as State).seen, [
						"ticker failed",
						"still running",
					]);
				}),
			),
		),
	);

	it.live("stops the process when the Sub lets an error escape", () =>
		Effect.scoped(
			withKernel(
				[rowWith("unmapped", {ticker: () => new Boom({})})],
				Effect.gen(function* () {
					const processes = yield* Processes;
					const handle = yield* processes.spawn(ProgramId.make("unmapped"), {
						services: Context.empty(),
					});
					yield* handle.dispatch({type: "arm"});
					yield* settle;

					const refused = yield* Effect.flip(handle.dispatch({type: "arm"}));
					assert.strictEqual(refused._tag, "tuval/host/ActorStoppedError");
				}),
			),
		),
	);
});
