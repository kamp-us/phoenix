/**
 * ADR 0346's two branches, proven through a registry row rather than a host-internal definition
 * literal (#7933): a row's `core.subFailure` is what the host consults when the row's own Effect Sub
 * handler fails. `host/sub-failure.unit.test.ts` covers the host in isolation; this covers the seam.
 */

import {type Cmd, type Sub, subId} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Schema} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {type AnyProgram, type Program, type ProgramCore, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {Processes} from "./Processes.ts";
import {ProcessTable} from "./ProcessTable.ts";

class Boom extends Schema.TaggedError<Boom>()("test/Boom", {}) {}

type State = {readonly armed: boolean; readonly seen: ReadonlyArray<string>};
type Msg = {readonly type: "arm"} | {readonly type: "noted"; readonly note: string};
type Ticker = Sub<"ticker">;

const TICKER: Ticker = {id: subId("ticker"), type: "ticker"};

/**
 * A plain literal, not `defineMachine`: that helper takes Demlik's `Machine`, which has no
 * `subFailure`. The host detects the update form when `__form` is absent (`host/definition.ts`).
 */
const coreWith = (
	subFailure?: ProgramCore<State, Msg, Cmd<never>, Ticker, unknown>["subFailure"],
): ProgramCore<State, Msg, Cmd<never>, Ticker, unknown> => ({
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
	...(subFailure === undefined ? {} : {subFailure}),
});

const rowWith = (
	id: string,
	subFailure?: ProgramCore<State, Msg, Cmd<never>, Ticker, unknown>["subFailure"],
): AnyProgram =>
	({
		id: ProgramId.make(id),
		core: coreWith(subFailure),
		ports: {},
		handlers: {},
		subs: {ticker: () => new Boom({})},
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

/** The policy runs on a detached fiber, so a dispatch's own quiescence does not cover it. */
const settle = Effect.sleep("20 millis");

describe("a program row's Sub-failure policy", () => {
	it.live("hands the Msg a row's subFailure returns to that process's update", () =>
		Effect.scoped(
			withKernel(
				[
					rowWith("addressed", (sub, failure) => ({
						type: "noted",
						note: `${sub.type}:${failure.reason}`,
					})),
				],
				Effect.gen(function* () {
					const processes = yield* Processes;
					const handle = yield* processes.spawn(ProgramId.make("addressed"), {
						services: Context.empty(),
					});
					yield* handle.dispatch({type: "arm"});
					yield* settle;

					assert.deepStrictEqual((handle.getState() as State).seen, ["ticker:failure"]);
				}),
			),
		),
	);

	it.live("ends the process when a row's subFailure returns undefined", () =>
		Effect.scoped(
			withKernel(
				[rowWith("unaddressed", () => undefined)],
				Effect.gen(function* () {
					const processes = yield* Processes;
					const handle = yield* processes.spawn(ProgramId.make("unaddressed"), {
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
