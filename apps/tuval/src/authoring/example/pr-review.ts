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
 * **`program({...})` is why no cell here states a type the layer already knows (#8825).** The
 * record has to live in a binding — this module exports it so a test can drive it, and `prReview`
 * below compiles it — and a `const` contextually types nothing, so every cell used to carry its own
 * `State`, its own event and its own `Answer<State>`. The one cell that still names an event is
 * `result`: a `Reply`'s name is chosen by the `spawn` above it, so it is the author's to declare
 * and nothing in the layer can read it back. `spawned` is not — it is the layer's own event with a
 * fixed name, and `UpdateTable` types it like `key`.
 *
 * That call's one-word name is this budget's doing. A longer one pushes the single import line
 * below past the formatter's width, which costs eight wrapped lines and breaks the ceiling
 * `pr-review.unit.test.ts` asserts — so the name was picked here, against this number, and
 * `program`'s own docblock points back to this paragraph rather than restating it.
 *
 * The one command is `send("pr", pr)`: a bare port name, which means an in-port of *this* program's
 * own process, looked up against this program's live processes at the call (`../own-process.ts`).
 * It is the whole of what a command may ask for — `send` and nothing else (ADR 0372) — and it is
 * the shape #8716 R16.1 asked for, so the example is the thing to copy rather than a documented
 * gap.
 *
 * **`spawned` is the follow-through, and it is why the authoring layer arrives through one door.**
 * A spawn answers with the child's process id, and that answer is the only moment this program can
 * address the reviewer's `prompt` port — without the cell the example starts a reviewer and never
 * asks it anything. `prompt` below stamps the turn, because `PromptPayload` requires all three of
 * its fields, and the key it stamps is the child's own id, so a redelivered send is dropped rather
 * than reviewed twice. The room for those four lines came from the barrel (`../index.ts`, the same
 * door a third-party program imports, #8943) rather than from a wider budget: the founder ruled the
 * ~30-line bar stands, at
 * [#8888](https://github.com/kamp-us/phoenix/issues/8888#issuecomment-5625301355).
 */

import {PromptPayloadSchema, TurnResultSchema} from "@kampus/tuval/ai-agent/ports";
import type {Reply, ShapeSource} from "@kampus/tuval/authoring";
import {defineProgram, emit, Program, port, program, programArgs, send, spawn} from "@kampus/tuval/authoring";
import {Schema} from "effect";

const agent = Program.shape({in: {prompt: PromptPayloadSchema}, out: {result: TurnResultSchema}});
const args = programArgs("pr-review", {reviewer: agent});
const prompt = (text: string, key: string) => ({text, key, timestamp: Date.now()});
type State = {readonly pr: number | null; readonly verdict: string | null};
export const prReviewProgram = program({
	id: "pr-review",
	ports: {pr: port.in(Schema.Number), verdict: port.out(Schema.String)},
	args,
	init: (): State => ({pr: null, verdict: null}),
	update: {
		pr: (s, e) => [{...s, pr: e.payload}, [spawn(args.reviewer, {on: {result: "result"}})]],
		spawned: (s, e) => [
			s,
			[send({process: e.process, port: "prompt"}, prompt(`review PR #${s.pr}`, e.process))],
		],
		result: (s, e: Reply<"result", typeof TurnResultSchema.Type>) => [
			{...s, verdict: e.payload.text},
			[emit("verdict", e.payload.text)],
		],
	},
	commands: {review: {args: Schema.Number, run: (pr: number) => send("pr", pr)}},
	title: (s) => (s.pr === null ? "pr-review" : `pr-review #${s.pr}`),
	status: (s) => s.verdict ?? "idle",
});

export const prReview = (fill: {readonly reviewer: ShapeSource}) =>
	defineProgram({...prReviewProgram, fill, label: `pr-review (${fill.reviewer.id})`});
