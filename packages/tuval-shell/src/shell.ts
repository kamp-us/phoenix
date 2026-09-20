/**
 * `shell` — a *job* program that takes a prompt and runs it as a shell command.
 *
 * It fits `@kampus/tuval-cron`'s `jobShape` exactly — `prompt` in, `result` out, both over the
 * payloads `@kampus/tuval/ai-agent/ports` publishes — and answers with output instead of with an
 * AI's turn. That is the whole point of it: the AI-agent port pair is an *interface*, not a claim
 * about what is behind it, so a scheduler written against that interface schedules `git fetch` with
 * no line of it changed and no agent anywhere in the picture.
 *
 * **Nothing runs on init and nothing runs on a timer.** A command is started by one thing — a
 * `PromptPayload` landing on `prompt` — and by nothing else. **Subs observe, handlers perform**
 * (#8716 R12.1): the `prompt` cell *asks* for the run, by answering this package's own effect
 * (`./runner.ts`), and the actor dispatches that ask to the handler spread onto the row (#9295).
 * A command is work that happens once because a cell decided it should, which is a Cmd; the Sub it
 * used to be made the child a function of `state.running` instead, which is what a subscription is
 * for and what a command is not.
 *
 * **One command at a time, and a second prompt is refused rather than dropped.** The caller is
 * waiting on `result` — that is what the port pair means — so a silently swallowed prompt is a
 * caller hung for ever. A prompt arriving mid-run gets a failed turn saying what is running, which
 * is an answer.
 *
 * *Read "immediately" out of that sentence for now.* The cell is correct — it refuses without
 * touching the child — but the refusal cannot reach the cell until the running command is over:
 * Tuval's actor awaits an authored handler inline under its single-permit semaphore, so a prompt
 * that lands mid-run waits in the inbox behind the run it would have been refused for. It is
 * queued, not dropped, and the caller still gets its `result`; what it does not get is a quick one.
 * The fix is the kernel's — kamp-us/phoenix#9297 — and this program's cells do not change with it.
 *
 * **A restart does not re-run the command.** A restored process starts on its checkpoint with no
 * effects, so nothing re-asks for a run — and that is the one thing a shell job must never do:
 * `rm -rf build && make install` is not something to replay because a desk was restarted. `resume`
 * writes the cut run down as interrupted and clears the request, so the tile says what happened.
 *
 * Everything it imports comes through Tuval's published doors — `@kampus/tuval/authoring` and
 * `@kampus/tuval/ai-agent/ports` (#8943). Nothing reaches the kernel.
 */

import {
	boundToolResult,
	ItemId,
	type PromptPayload,
	PromptPayloadSchema,
	type TranscriptItem,
	type TurnResult,
	TurnResultSchema,
} from "@kampus/tuval/ai-agent/ports";
import {
	type Answer,
	type AnyProgram,
	type ArrivalEvent,
	type AuthoredEvent,
	defineProgram,
	emit,
	port,
} from "@kampus/tuval/authoring";
import type {Context} from "effect";
import type {Finished} from "./run.ts";
import {
	RUN,
	type Run,
	run as runEffect,
	runHandler,
	type ShellRunner,
	ShellRunnerLive,
} from "./runner.ts";
import {
	basename,
	commandHead,
	type ShellEnding,
	type ShellRequest,
	type ShellRun,
	type ShellState,
	statusLine,
	succeeded,
	titleLine,
} from "./state.ts";

/** The id a shell takes when a config does not name one. */
export const DEFAULT_ID = "shell";

/** The interpreter a shell takes when a config does not name one. */
export const DEFAULT_SHELL = "/bin/zsh";

/** What a shell job takes. `cwd` is the only thing it will not guess. */
export interface ShellOptions {
	/**
	 * What this shell is called: its program id and its graph node id. Defaults to `"shell"` — name
	 * it when a config holds more than one, because two rows under one id collide on both.
	 */
	readonly id?: string;
	/** Where every command runs. Not created, not checked: a `cwd` that is not there is a failed run. */
	readonly cwd: string;
	/**
	 * The interpreter, invoked as `<shell> -c <command>`. Defaults to `/bin/zsh`. It is a *shell* and
	 * not an argv on purpose: a prompt is a command line, so `a | b && c` has to mean what it says.
	 */
	readonly shell?: string;
	/** Kill the command's process group after this long. Absent waits as long as the command takes. */
	readonly timeoutMs?: number;
	/** Extra environment, over the ambient one. */
	readonly env?: Readonly<Record<string, string>>;
}

/**
 * The id, checked — cron's rule, restated here because it is the same rule for the same reason: an
 * id is also a graph node id, and a node id with whitespace in it addresses nothing. Refused at
 * `shell(...)`, where the config is being written, rather than at the first prompt on a live desk.
 */
const checkedId = (id: string | undefined): string => {
	if (id === undefined) return DEFAULT_ID;
	if (id.trim() === "" || /\s/.test(id)) {
		throw new Error(
			`shell: \`id\` must be a non-empty word with no spaces — it is the program id and the graph node id: ${JSON.stringify(id)}`,
		);
	}
	return id;
};

/**
 * The timeout, checked. `0` and a negative are refused rather than taken literally: a timeout of
 * zero would kill every command before it ran, which is never what a config meant to write.
 */
const checkedTimeout = (timeoutMs: number | undefined): number | null => {
	if (timeoutMs === undefined) return null;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error(
			`shell: \`timeoutMs\` must be a positive number of milliseconds, or absent for no timeout: ${JSON.stringify(timeoutMs)}`,
		);
	}
	return timeoutMs;
};

/** How a finished child is read as an ending. The one place the three failure modes are told apart. */
const endingOf = (event: Finished): ShellEnding => {
	if (event.timedOut) return {_tag: "timeout"};
	return event.code === null ? {_tag: "killed"} : {_tag: "exit", code: event.code};
};

/**
 * The run, as one transcript item.
 *
 * `TranscriptItem`'s union has a member that fits a shell run exactly, so nothing is faked and the
 * array is not empty: a `tool` item is "a named thing ran with this input and produced this
 * result", which is what happened. `name` is this program's id, `input` is the command and the
 * directory as plain JSON, and `result` goes through the port's own `boundToolResult` — the item's
 * bound is 8 KB and is the port's, not this package's, so the same output is carried twice at two
 * different bounds: whole-ish in the turn's `text` (64 KB), cut to the item bound here.
 *
 * `status` is `"ok"` or `"error"` and never `"running"`: an item is minted when the run is over.
 */
const itemsFor = (
	id: string,
	cwd: string,
	run: ShellRun,
	output: string,
): ReadonlyArray<TranscriptItem> => [
	{
		kind: "tool",
		id: ItemId.make(run.key),
		timestamp: run.startedAt + run.durationMs,
		name: id,
		input: {command: run.command, cwd},
		result: boundToolResult(output),
		status: succeeded(run) ? "ok" : "error",
	},
];

/** The turn a finished run answers with: the output, the verdict, and the run as one item. */
const turnFor = (id: string, cwd: string, run: ShellRun, output: string): TurnResult => ({
	text: output,
	items: itemsFor(id, cwd, run, output),
	ok: succeeded(run),
});

/**
 * The turn a prompt that arrived mid-run gets. A `system` item, which is the union's member for
 * "one backend notice" — the honest kind for a line about the program rather than about a command,
 * since no command ran.
 */
const busyTurn = (state: ShellState, payload: PromptPayload): TurnResult => {
	const running = state.running;
	const text =
		running === null
			? "nothing was run"
			: `${state.id} is already running ${commandHead(running.command)} — nothing was run`;
	return {
		text,
		items: [
			{
				kind: "system",
				id: ItemId.make(`${payload.key}-refused`),
				timestamp: payload.timestamp,
				text,
				detail: payload.text,
			},
		],
		ok: false,
	};
};

/**
 * The ask, built from the config and the prompt. Every field of it was decided before this function
 * was called, which is the point of a Cmd: the cell hands the handler a finished decision and holds
 * nothing. `key` is the prompt's own, so the `finished` that comes back names the turn it answers.
 */
const askFor = (
	options: ShellOptions,
	shellPath: string,
	timeoutMs: number | null,
	request: ShellRequest,
): Run =>
	runEffect({
		key: request.key,
		command: request.command,
		cwd: options.cwd,
		shell: shellPath,
		timeoutMs,
		env: options.env,
	});

/**
 * The authored record, over one set of options. A function rather than a constant because `cwd` and
 * the interpreter are the config's to state, and both are read when a run is asked for.
 */
export const shellProgram = (options: ShellOptions) => {
	const id = checkedId(options.id);
	const shellPath = options.shell ?? DEFAULT_SHELL;
	const timeoutMs = checkedTimeout(options.timeoutMs);
	return {
		id,
		/**
		 * The two ports `jobShape` names, over the payload schemas the AI-agent interface publishes —
		 * the *interface* module, which pulls in no agent. Declaring them from there rather than
		 * restating their shape is what makes a `Program.shape` check compare one canonical schema
		 * against itself instead of two hand-written near-copies.
		 */
		ports: {
			prompt: port.in(PromptPayloadSchema),
			result: port.out(TurnResultSchema),
		},
		init: (): ShellState => ({
			id,
			cwd: options.cwd,
			running: null,
			last: null,
		}),
		update: {
			/**
			 * A command was asked for. Nothing is *started* here — the cell writes the request down and
			 * answers `run({…})`, and the handler on the row is what spawns (`./runner.ts`). The reducer
			 * stays a pure function of state and event, which is the whole discipline; what changed from
			 * the Sub it used to be is only which side of that line the child is opened on.
			 *
			 * `startedAt` is the prompt's own stamp rather than a clock reading: the sender timestamps
			 * the turn (`PromptPayload`), this program reads no clock, and the duration a run reports is
			 * measured by the runner around the child rather than derived from two readings here.
			 */
			prompt: (
				state: ShellState,
				event: ArrivalEvent<"prompt", PromptPayload>,
			): Answer<ShellState, Run> => {
				if (state.running !== null) {
					return [state, [emit("result", busyTurn(state, event.payload))]];
				}
				const request: ShellRequest = {
					key: event.payload.key,
					command: event.payload.text,
					startedAt: event.payload.timestamp,
				};
				return [{...state, running: request}, [askFor(options, shellPath, timeoutMs, request)]];
			},
			/**
			 * The child is over. A finish naming a key that is not the running one is dropped: a request
			 * is cleared only by the finish that answered it or by a restart, so this can only be a
			 * report that raced one, and answering it would be a second `result` for a turn already
			 * answered.
			 */
			finished: (state: ShellState, event: Finished): Answer<ShellState, Run> => {
				const request = state.running;
				if (request === null || request.key !== event.key) return [state, []];
				const run: ShellRun = {
					...request,
					ending: endingOf(event),
					durationMs: event.durationMs,
				};
				return [
					{...state, running: null, last: run},
					[emit("result", turnFor(id, options.cwd, run, event.output))],
				];
			},
			/**
			 * Shell came back from a checkpoint. If it was holding a request, a restart cut a command in
			 * half: it is written down as interrupted and cleared. Nothing re-asks for the run — a
			 * restored process starts on its state with no effects — so the command is not replayed.
			 *
			 * No `result` is emitted for it, deliberately. The turn it would answer belongs to a caller
			 * that is itself being restored — cron's own `restored` writes the same run down as failed on
			 * its side — and a `result` emitted at boot would land on whatever the graph has wired now.
			 */
			restored: (state: ShellState, _event: AuthoredEvent): Answer<ShellState, Run> => {
				// The config is the authority on `id` and `cwd`, and a checkpoint is not: both are env, so
				// a restore re-seeds them from the options this shell was just built with.
				const env = {id, cwd: options.cwd};
				if (state.running === null) return [{...state, ...env}, []];
				return [
					{
						...state,
						...env,
						running: null,
						last: {
							...state.running,
							ending: {_tag: "interrupted"},
							durationMs: 0,
						},
					},
					[],
				];
			},
		},
		/** The one door a restarted shell has back into the world — see `restored` above. */
		resume: (_state: ShellState) => [{type: "restored" as const}],
		title: titleLine,
		status: statusLine,
	};
};

/**
 * The authored record's two halves that `defineProgram`'s type argument list has to name in full.
 * Exported because a test that drives the authored record is the other place they are written down
 * — `testProgram`'s signature predates `X` (#9294), so it is annotated at these two rather than
 * inferring them.
 */
export type ShellAuthored = ReturnType<typeof shellProgram>;
export type ShellPorts = ShellAuthored["ports"];
export type ShellUpdate = ShellAuthored["update"];

/**
 * The row, as a config writes it: `shell({cwd: "/path/to/repo"})`. It declares no args and fills
 * none — a shell job is handed its command by the prompt, so there is nothing for a config to wire
 * into it beyond where it runs.
 */
export const shell = (
	options: ShellOptions,
	/**
	 * What actually spawns, already built. Defaulted to the real one; a test hands a fake and gets
	 * the whole program with no child in it. It is a parameter rather than a field on `ShellOptions`
	 * because a *config* has no business choosing one — this is the seam, not a setting — and a
	 * `Context` rather than a `Layer` because the handler runs once per command and `./runner.ts`
	 * says at length what a per-command `Layer` build would cost.
	 */
	runner: Context.Context<ShellRunner> = ShellRunnerLive,
): AnyProgram => {
	const authored = shellProgram(options);
	// `Run` is named only in a cell's *answer*, which is not a place inference reaches, so the whole
	// argument list is stated once (#9294).
	const row = defineProgram<ShellState, ShellPorts, ShellUpdate, Record<string, never>, Run>({
		...authored,
		label: `${authored.id} (${basename(options.cwd)})`,
	});
	// The one handler the compiler does not write. The spread *is* the seam: `defineProgram` cannot
	// see a handler added after it returns, so this line is what makes `run` a performed effect
	// rather than one the actor skips in silence. `runHandler` reads the service here, once, and the
	// function it answers closes over it.
	return {...row, handlers: {...row.handlers, [RUN]: runHandler(runner)}};
};
