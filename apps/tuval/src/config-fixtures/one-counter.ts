import {defineMachine} from "@demlik/tea";
import {Effect} from "effect";
import type {AnyProgram, Program} from "../registry/program.ts";
import {ProgramId} from "../registry/program.ts";

type State = {readonly count: number};
type Msg = {readonly type: "tick"};
type Notify = {readonly type: "notify"};

/** One real program row at version 1.0.0, for the boot tests that seed a state dir beside it. */
const counter = {
	id: ProgramId.make("counter"),
	core: defineMachine<State, Msg, Notify, never, unknown>({
		init: (loaded) => [loaded ?? {count: 0}, []],
		update: {tick: (state) => [{count: state.count + 1}, [{type: "notify"}]]},
		interpret: {notify: () => Promise.resolve()},
	}),
	ports: {},
	handlers: {notify: () => Effect.succeed([] as ReadonlyArray<Msg>)},
	capabilities: [],
	identity: {package: "@kampus/tuval", program: "counter", version: "1.0.0", digest: "sha256:x"},
	placement: {host: "local"},
} satisfies Program<State, Msg, Notify, never, unknown, never, never>;

const programs: ReadonlyArray<AnyProgram> = [counter];

export default {version: 1, programs};
