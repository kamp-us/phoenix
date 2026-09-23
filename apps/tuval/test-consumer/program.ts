/**
 * The fixture behind #8943's declaration-emit criterion, and the only module in this repo compiled
 * the way an outside package compiles: through the `exports` map, with `declaration: true`.
 *
 * Its whole point is what it *exports*. `outsideArgs` and `outsideProgram` have inferred types
 * reaching `ArgRefs`, `ProgramArgRef`, `ArgIdentity` and `Spawnable`; `defineProgram`'s return
 * reaches `AnyProgram`, and the state below reaches `ProcessId`. Emitting a `.d.ts` forces the
 * compiler to write each of those names down, and it can only do that through a public specifier —
 * so a name dropped from the barrel fails here with TS2742 ("cannot be named without a reference
 * to …/src/authoring/args") rather than in a consumer's release build.
 *
 * `../src/` is unreachable from this file on purpose: `tsconfig.json` here includes this module
 * alone, and every import below is a package specifier.
 */

import {PromptPayloadSchema, TurnResultSchema} from "@kampus/tuval-sdk/ai-agent/ports";
import {
	type Answer,
	type AnyProgram,
	type ArrivalEvent,
	defineProgram,
	emit,
	type ProcessId,
	Program,
	port,
	programArgs,
	type Reply,
	type ShapeSource,
	STATUS_PORT,
	send,
	spawn,
	stop,
	TITLE_PORT,
} from "@kampus/tuval-sdk/authoring";
import {
	ClientId,
	claudeSession,
	type TuvalConfigInput,
	WorkspaceId,
} from "@kampus-apps/tuval/sessions";
import {Schema} from "effect";

const worker = Program.shape({in: {prompt: PromptPayloadSchema}, out: {result: TurnResultSchema}});

/** Inferred as `ArgRefs<"outside-cron", {worker: …}>` — the type TS2742 fires on. */
export const outsideArgs = programArgs("outside-cron", {worker});

export type State = {readonly child: ProcessId | null; readonly said: string | null};

export const outsideProgram = {
	id: "outside-cron",
	ports: {run: port.in(Schema.String), said: port.out(Schema.String)},
	args: outsideArgs,
	init: (): State => ({child: null, said: null}),
	update: {
		run: (s: State, _e: ArrivalEvent<"run", string>): Answer<State> => [
			s,
			[spawn(outsideArgs.worker, {on: {result: "result"}}), emit(TITLE_PORT, "outside-cron")],
		],
		result: (s: State, e: Reply<"result", {readonly text: string}>): Answer<State> => [
			{...s, said: e.payload.text},
			[
				emit("said", e.payload.text),
				emit(STATUS_PORT, "done"),
				...(s.child === null ? [] : [stop(s.child)]),
			],
		],
	},
	commands: {run: {args: Schema.String, run: (q: string) => send("run", q)}},
	title: (s: State) => s.said ?? "outside-cron",
};

export const outsideCron = (fill: {readonly worker: ShapeSource}): AnyProgram =>
	defineProgram({...outsideProgram, fill, label: `outside-cron (${fill.worker.id})`});

/** The config half, annotated the way a config module annotates itself. */
export const config: TuvalConfigInput = {
	version: 1,
	programs: [
		outsideCron({
			worker: claudeSession({
				cwd: "/tmp/tuval-8943",
				scope: {
					workspace: WorkspaceId.make("tuval/outside"),
					client: ClientId.make("tuval/outside"),
				},
			}),
		}),
	],
};
