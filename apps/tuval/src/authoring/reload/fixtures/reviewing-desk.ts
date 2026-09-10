/**
 * The config layer the authoring reload/restore proof boots: the worked `pr-review` example
 * (`../../example/pr-review.ts`), the reviewer it is handed, and the two plain rows that drive it
 * and read it back.
 *
 * What each generation holds is read at import out of the JSON file `TUVAL_AUTHORING_FIXTURE`
 * names, exactly as `../../../config-fixtures/reloadable.ts` reads its own — so rewriting that file
 * and loading the config again is a genuine config change rather than a second call over one
 * config. `reviewing` is the pull request this generation names, and it is the setting the spread
 * `configChanged` below compares.
 *
 * **Two shapes here are the substrate's gaps, not the example's.** A shaped arg's spawn resolves
 * the arg's own service key straight through the registry, so the reviewer is registered under
 * exactly that key until [#8762](https://github.com/kamp-us/phoenix/issues/8762) lands. And a graph
 * route compiles only between two ports of one `kind`, which `../../port.ts` derives from the
 * declaring program's id — so `desk` and `sink` are plain rows written against `pr-review`'s own
 * kinds, because two authored programs cannot be routed to each other today
 * ([#8923](https://github.com/kamp-us/phoenix/issues/8923)).
 */

import {readFileSync} from "node:fs";
import {defineMachine} from "@demlik/tea";
import {Effect, Schema} from "effect";
import type {TuvalConfigInput} from "../../../config.ts";
import {ProcessPorts} from "../../../ports/ProcessPorts.ts";
import {type AnyProgram, type Program, ProgramId} from "../../../registry/program.ts";
import {type Answer, type ArrivalEvent, defineProgram} from "../../define-program.ts";
import {emit} from "../../effect.ts";
import {prReview} from "../../example/pr-review.ts";
import {port, portKind} from "../../port.ts";
import {
	DESK_NODE,
	type DeclaredReview,
	FIXTURE_VAR,
	REVIEW_NODE,
	REVIEW_PROGRAM,
	REVIEWER_PROGRAM,
	SINK_NODE,
	VERDICT,
} from "./names.ts";

const declared = JSON.parse(readFileSync(process.env[FIXTURE_VAR] ?? "", "utf8")) as DeclaredReview;

type ReviewerState = {readonly asked: string | null};

/**
 * The reviewer the example is handed: it answers on `result`, which the example's `spawn` routes
 * back as its own `result` event. `replay` is the cell a restored reviewer's `resume` reaches, and
 * this generation decides whether it declares one at all.
 */
const reviewer = defineProgram({
	id: REVIEWER_PROGRAM,
	ports: {prompt: port.in(Schema.String), result: port.out(Schema.String)},
	init: (): ReviewerState => ({asked: null}),
	update: {
		prompt: (
			_state: ReviewerState,
			event: ArrivalEvent<"prompt", string>,
		): Answer<ReviewerState> => [{asked: event.payload}, [emit("result", VERDICT)]],
		replay: (state: ReviewerState): Answer<ReviewerState> => [state, [emit("result", VERDICT)]],
	},
	// A state with nothing to resume answers with an empty list, which is the row contract; this
	// generation is what decides whether there is anything to say.
	resume: () => (declared.resumeEmits ? [{type: "replay" as const}] : []),
});

/** The row the example compiles to, plus the one lifecycle field the authoring layer does not sugar. */
type ReviewRow = AnyProgram & {readonly reviewing: number};

const reviewing = (row: AnyProgram): number => (row as ReviewRow).reviewing;

export const reviewRow: ReviewRow = {
	...prReview({reviewer: {id: REVIEWER_PROGRAM}}),
	reviewing: declared.reviewing,
	// The spread half: a re-read config that names another pull request tells the live process so,
	// as an arrival on the port it already takes. A generation that moved nothing says nothing.
	configChanged: (next: AnyProgram) =>
		reviewing(next) === declared.reviewing
			? []
			: [{type: "pr", payload: reviewing(next)} satisfies ArrivalEvent<"pr", number>],
};

type EmitCmd = {readonly type: "emit"; readonly port: string; readonly payload: unknown};

const emitHandler = (cmd: EmitCmd) =>
	Effect.gen(function* () {
		yield* (yield* ProcessPorts).emit(cmd.port, cmd.payload);
		return [] as ReadonlyArray<never>;
	});

type DeskState = {readonly sent: ReadonlyArray<number>};
type DeskMsg = {readonly type: "say"; readonly pr: number};

/** What an operator's window would be: it emits onto the example's `pr` in-port and remembers. */
const desk: AnyProgram = {
	id: ProgramId.make(DESK_NODE),
	core: defineMachine<DeskState, DeskMsg, EmitCmd, never, unknown>({
		init: (loaded) => [loaded ?? {sent: []}, []],
		update: {
			say: (state, msg) => [
				{sent: [...state.sent, msg.pr]},
				[{type: "emit", port: "pr", payload: msg.pr}],
			],
		},
		interpret: {emit: () => Promise.resolve()},
	}),
	ports: {
		pr: {
			kind: portKind(ProgramId.make(REVIEW_PROGRAM), "pr"),
			direction: "out",
			accepts: Schema.is(Schema.Number),
		},
	},
	handlers: {emit: emitHandler},
	capabilities: [],
	identity: {
		package: "@kampus/tuval",
		program: DESK_NODE,
		version: "1.0.0",
		digest: `sha256:${DESK_NODE}`,
	},
	placement: {host: "local"},
} satisfies Program<DeskState, DeskMsg, EmitCmd, never, unknown, unknown, ProcessPorts>;

type SinkState = {readonly heard: ReadonlyArray<string>};
type SinkMsg = {readonly type: "took"; readonly verdict: string};

/** The reader on the other end of the example's `verdict` route: what it heard, in arrival order. */
const sink: AnyProgram = {
	id: ProgramId.make(SINK_NODE),
	core: defineMachine<SinkState, SinkMsg, never, never, unknown>({
		init: (loaded) => [loaded ?? {heard: []}, []],
		update: {took: (state, msg) => [{heard: [...state.heard, msg.verdict]}, []]},
		interpret: {},
	}),
	ports: {
		verdict: {
			kind: portKind(ProgramId.make(REVIEW_PROGRAM), "verdict"),
			direction: "in",
			accepts: Schema.is(Schema.String),
			bound: {capacity: 16, overflow: "suspend"},
		},
	},
	receive: {verdict: (payload: unknown) => ({type: "took", verdict: payload as string})},
	handlers: {},
	capabilities: [],
	identity: {
		package: "@kampus/tuval",
		program: SINK_NODE,
		version: "1.0.0",
		digest: `sha256:${SINK_NODE}`,
	},
	placement: {host: "local"},
} satisfies Program<SinkState, SinkMsg, never, never, unknown, never, never>;

export default {
	version: 1,
	programs: [reviewRow, reviewer, desk, sink],
	graph: {
		nodes: [
			{id: DESK_NODE, program: DESK_NODE, on: [{port: "pr", to: {node: REVIEW_NODE, port: "pr"}}]},
			{
				id: REVIEW_NODE,
				program: REVIEW_PROGRAM,
				on: [{port: "verdict", to: {node: SINK_NODE, port: "verdict"}}],
			},
			{id: SINK_NODE, program: SINK_NODE, on: []},
		],
	},
} satisfies TuvalConfigInput;
