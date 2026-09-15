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
 * That call is `defineProgram`'s `fill`: the reviewer the config chose is checked against the
 * declared shape at definition time and put in the handlers' `R`, which is how the `spawn` below
 * resolves to the reviewer's own id rather than to the arg key (#8762). What made that fill
 * impossible until now is that the config's only candidate is a shipped session row, and a shipped
 * row published payload predicates rather than the schemas a shape is checked against — #8887
 * closed that, so the two payload schemas the shape is declared over come from `ai-agent/ports`,
 * the port vocabulary every Tuval AI agent speaks, and not from any one agent's package. That
 * module's own `boundary.unit.test.ts` holds it to `effect` plus the kernel's program row, so the
 * import drags in no agent implementation; it is what R15.1 asks for rather than what it forbids,
 * because both ends naming one payload is what gives the structural check anything to compare. The
 * guard in `pr-review.unit.test.ts` still refuses an import of `codex/`, `claude/`, `pi/` or
 * `agy/`. Declaring `Schema.String` here instead would name a shape no shipped agent carries and no
 * shipped row could ever fill.
 *
 * `sendPr` is where the one command lands its payload, and it is the one place the example is not
 * yet the thing to copy: a command's `Scope.process` is *the caller's* — the process behind the
 * window the call came from — never the declaring program's own (ADR 0372). This program declares no
 * `window`, so no window ever shows one of its processes and `scope.process` can never be one. The
 * shape #8716 R16.1 asks for, `send("pr", pr)` against the program's own port, has no compilation
 * path today; #8898 carries that gap.
 */

import {Schema} from "effect";
import {PromptPayloadSchema, TurnResultSchema} from "../../ai-agent/ports/index.ts";
import {programArgs} from "../args.ts";
import type {Scope} from "../commands.ts";
import {type Answer, type ArrivalEvent, defineProgram} from "../define-program.ts";
import {emit, type Reply, send, spawn} from "../effect.ts";
import {port} from "../port.ts";
import {Program, type ShapeSource} from "../shape.ts";

const agent = Program.shape({in: {prompt: PromptPayloadSchema}, out: {result: TurnResultSchema}});
const args = programArgs("pr-review", {reviewer: agent});
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
		result: (s: State, e: Reply<"result", typeof TurnResultSchema.Type>): Answer<State> => [
			{...s, verdict: e.payload.text},
			[emit("verdict", e.payload.text)],
		],
	},
	commands: {review: {args: Schema.Number, run: sendPr}},
	title: (s: State) => (s.pr === null ? "pr-review" : `pr-review #${s.pr}`),
	status: (s: State) => s.verdict ?? "idle",
};

export const prReview = (fill: {readonly reviewer: ShapeSource}) =>
	defineProgram({...prReviewProgram, fill, label: `pr-review (${fill.reviewer.id})`});
