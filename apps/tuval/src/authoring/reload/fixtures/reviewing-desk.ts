/**
 * The config layer the authoring reload/restore proof boots: the worked `pr-review` example
 * (`../../example/pr-review.ts`), the reviewer it is handed, and the two authored rows that drive it
 * and read it back.
 *
 * What each generation holds is read at import out of the JSON file `TUVAL_AUTHORING_FIXTURE`
 * names, exactly as `../../../config-fixtures/reloadable.ts` reads its own — so rewriting that file
 * and loading the config again is a genuine config change rather than a second call over one
 * config. `reviewing` is the pull request this generation names, and it is the setting the spread
 * `configChanged` below compares.
 *
 * **This layer states the fill, because a fill is a config's to state.** The example names its
 * reviewer by ports alone, so this module is the one that says which program fills that arg
 * ([#8762](https://github.com/kamp-us/phoenix/issues/8762)), and it states it through `prReview`
 * itself — the factory takes a `ShapeSource` and threads it into `defineProgram`'s `fill`, so there
 * is no longer a second way in ([#8887](https://github.com/kamp-us/phoenix/issues/8887)). What it
 * hands is the reviewer's compiled row, whose ports publish the payload schemas a shape is checked
 * against.
 *
 * **Every row here is authored.** `desk` and `sink` were plain rows hand-writing `pr-review`'s own
 * kinds, because a graph route used to compile only between two ports of one `kind` and
 * `../../port.ts` derives a kind from the declaring program's id — so two authored programs could
 * never be wired. A route is decided by payload fit now (ADR 0395,
 * [#8923](https://github.com/kamp-us/phoenix/issues/8923)), so they say what they carry and the
 * graph does the rest: `desk.pr` carries a number and `pr-review.pr` takes one, `pr-review.verdict`
 * carries a line and `sink.verdict` takes one. Nothing in this module spells a kind.
 */

import {readFileSync} from "node:fs";
import {
	type PromptPayload,
	PromptPayloadSchema,
	TurnResultSchema,
} from "@kampus/tuval-sdk/ai-agent/ports";
import {
	type Answer,
	type ArrivalEvent,
	defineProgram,
} from "@kampus/tuval-sdk/kernel/authoring/define-program";
import {emit} from "@kampus/tuval-sdk/kernel/authoring/effect";
import {port} from "@kampus/tuval-sdk/kernel/authoring/port";
import type {AnyProgram} from "@kampus/tuval-sdk/kernel/registry/program";
import {Schema} from "effect";
import type {TuvalConfigInput} from "../../../config.ts";
import {prReview} from "../../example/pr-review.ts";
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
 * The ports the reviewer publishes, named once: the row is compiled from them and the fill below is
 * checked against them, so the thing registered and the thing checked cannot drift apart. They are
 * the two payloads `pr-review`'s shape declares — the fit is over these schemas and nothing else,
 * so a reviewer written against a bare line would be refused at this layer's load (#8887).
 */
const reviewerPorts = {prompt: port.in(PromptPayloadSchema), result: port.out(TurnResultSchema)};

/**
 * The reviewer the example is handed: it answers on `result`, which the example's `spawn` routes
 * back as its own `result` event. `replay` is the cell a restored reviewer's `resume` reaches, and
 * this generation decides whether it declares one at all.
 */
const turn = (text: string) => ({text, items: [], ok: true});

const reviewer = defineProgram({
	id: REVIEWER_PROGRAM,
	ports: reviewerPorts,
	init: (): ReviewerState => ({asked: null}),
	update: {
		prompt: (
			_state: ReviewerState,
			event: ArrivalEvent<"prompt", PromptPayload>,
		): Answer<ReviewerState> => [{asked: event.payload.text}, [emit("result", turn(VERDICT))]],
		replay: (state: ReviewerState): Answer<ReviewerState> => [
			state,
			[emit("result", turn(VERDICT))],
		],
	},
	// A state with nothing to resume answers with an empty list, which is the row contract; this
	// generation is what decides whether there is anything to say.
	resume: () => (declared.resumeEmits ? [{type: "replay" as const}] : []),
});

/** The row the example compiles to, plus the one lifecycle field the authoring layer does not sugar. */
type ReviewRow = AnyProgram & {readonly reviewing: number};

const reviewing = (row: AnyProgram): number => (row as ReviewRow).reviewing;

export const reviewRow: ReviewRow = {
	// The compiled row itself, handed to the example's own config factory. That factory takes a
	// `ShapeSource` now and threads it into `fill`, so this layer no longer has to reach past
	// `prReview` to `defineProgram` to state one (#8887, #8955).
	...prReview({reviewer}),
	reviewing: declared.reviewing,
	// The spread half: a re-read config that names another pull request tells the live process so,
	// as an arrival on the port it already takes. A generation that moved nothing says nothing.
	configChanged: (next: AnyProgram) =>
		reviewing(next) === declared.reviewing
			? []
			: [{type: "pr", payload: reviewing(next)} satisfies ArrivalEvent<"pr", number>],
};

type DeskState = {readonly sent: ReadonlyArray<number>};

/** Not a port arrival: the event the proof dispatches to make the desk speak, as `replay` is above. */
type Say = {readonly type: "say"; readonly pr: number};

/**
 * What an operator's window would be: it announces a pull request on `pr` and remembers what it
 * sent. It names no kind and imports nothing of `pr-review`'s — it declares that it carries a
 * number, and the example declares that it takes one, which is the whole of what makes the route in
 * `graph` below compile (#8923).
 */
const desk = defineProgram({
	id: DESK_NODE,
	ports: {pr: port.out(Schema.Number)},
	init: (): DeskState => ({sent: []}),
	update: {
		say: (state: DeskState, event: Say): Answer<DeskState> => [
			{sent: [...state.sent, event.pr]},
			[emit("pr", event.pr)],
		],
	},
});

type SinkState = {readonly heard: ReadonlyArray<string>};

/** The reader on the other end of the example's `verdict` route: what it heard, in arrival order. */
const sink = defineProgram({
	id: SINK_NODE,
	ports: {verdict: port.in(Schema.String)},
	init: (): SinkState => ({heard: []}),
	update: {
		verdict: (state: SinkState, event: ArrivalEvent<"verdict", string>): Answer<SinkState> => [
			{heard: [...state.heard, event.payload]},
			[],
		],
	},
});

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
