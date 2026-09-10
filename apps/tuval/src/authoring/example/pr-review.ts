/**
 * The worked example (#8716 R11.1): `pr-review` asks a reviewer about a pull request and announces
 * the verdict it gets back. It is what a newcomer copies, so its whole point is the line count —
 * the 94-line demo counter this replaces is the number the epic exists to beat, and
 * `pr-review.unit.test.ts` asserts the ceiling so it cannot drift.
 *
 * It imports no other program's package. The reviewer arrives as an arg typed by its ports alone
 * (`Program.shape`), so this module names no reviewer and drags in no reviewer's SDK (R15.1); which
 * program fills it is `.tuval/tuval.config.ts`'s call, and `prReview` below is that call — it names
 * the reviewer this registration hands the arg, and the row's label says so.
 *
 * `sendPr` is where the one command lands its payload: a spell runs under the process whose window
 * is focused, so `:pr-review review 8690` reaches this program's own `pr` port and nobody else's.
 */

import {Schema} from "effect";
import {programArgs} from "../args.ts";
import type {Scope} from "../commands.ts";
import {type Answer, type ArrivalEvent, defineProgram} from "../define-program.ts";
import {emit, type Reply, send, spawn} from "../effect.ts";
import {port} from "../port.ts";
import {Program} from "../shape.ts";

const reviewer = Program.shape({in: {prompt: Schema.String}, out: {result: Schema.String}});
const args = programArgs("pr-review", {reviewer});
type State = {readonly pr: number | null; readonly verdict: string | null};
const sendPr = (pr: number, {process}: Scope) => (process ? [send({process, port: "pr"}, pr)] : []);
export const prReviewProgram = {
	id: "pr-review",
	ports: {pr: port.in(Schema.Number), verdict: port.out(Schema.String)},
	args,
	init: (): State => ({pr: null, verdict: null}),
	update: {
		pr: (s: State, e: ArrivalEvent<"pr", number>): Answer<State> => [
			{...s, pr: e.payload},
			[spawn(args.reviewer, {on: {result: "result"}})],
		],
		result: (s: State, e: Reply<"result", string>): Answer<State> => [
			{...s, verdict: e.payload},
			[emit("verdict", e.payload)],
		],
	},
	commands: {review: {args: Schema.Number, run: sendPr}},
	title: (s: State) => (s.pr === null ? "pr-review" : `pr-review #${s.pr}`),
	status: (s: State) => s.verdict ?? "idle",
};

export const prReview = (fill: {readonly reviewer: {readonly id: string}}) =>
	defineProgram({...prReviewProgram, label: `pr-review (${fill.reviewer.id})`});
