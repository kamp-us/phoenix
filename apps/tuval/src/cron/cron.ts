/**
 * `cron` — a program that wakes on a timer, starts a *job* program, and says on its board tile how
 * that went. That is the whole of v1: it schedules, it reports, and it knows nothing else.
 *
 * The job arrives as an arg typed by its ports alone (`Program.shape`, #8716 R15.1), so this module
 * names no session and imports no session's package — which program fills it is
 * `.tuval/tuval.config.ts`'s call. Unlike the `pr-review` example, the shape is declared over the
 * *real* AI-agent payloads (`../ai-agent/ports/payloads.ts`): a `prompt` carrying `{text, key,
 * timestamp}` and a `result` carrying `{text, items, ok}`, so a real Claude or Codex session is the
 * kind of thing that fits it. The two schemas below restate those payloads rather than importing
 * them, because `payloads.ts` publishes hand-written predicates and a shape is decided over schemas.
 *
 * `sessionAsJob` is the seam that costs something, and it is a workaround, not a design. `shapeOf`
 * (`../authoring/shape.ts`) now reads a *compiled* row's ports too (#8887) — but only a row built
 * by `defineProgram`, because `compilePort` is what publishes each port's schema beside the
 * kernel's predicate. `claudeSession` is not authored that way: `../ai-agent/ports/ports.ts` writes
 * its `InPort`/`OutPort` records by hand, predicate only, so `shapeOf` of a live session is still
 * `{in: {}, out: {}}` and no non-empty shape can fit one. Until an AI-agent row is authored through
 * `defineProgram`, a config hands the arg the row's id beside a re-declaration of the two ports it
 * is being asked for. `cron.unit.test.ts` pins both halves: that the wrapper fits, and that the
 * real row's own `accepts` predicates admit exactly these payloads.
 */

import type {DepKeyedSub} from "@demlik/tea";
import {Schema} from "effect";
import {programArgs} from "../authoring/args.ts";
import {type Answer, type AuthoredEvent, defineProgram} from "../authoring/define-program.ts";
import {type Reply, type Spawned, type Stopped, send, spawn, stop} from "../authoring/effect.ts";
import {port} from "../authoring/port.ts";
import {Program, type ShapeSource} from "../authoring/shape.ts";
import type {ProcessId} from "../process/process.ts";
import type {AnyProgram} from "../registry/program.ts";

/** One turn of operator text, as `../ai-agent/ports/payloads.ts` `PromptPayload` carries it. */
export const PromptPayload = Schema.Struct({
	text: Schema.String,
	key: Schema.String,
	timestamp: Schema.Number,
});

/** One finished turn, as `../ai-agent/ports/payloads.ts` `TurnResult` carries it. */
export const TurnResult = Schema.Struct({
	text: Schema.String,
	items: Schema.Array(Schema.Unknown),
	ok: Schema.Boolean,
});
export type TurnResult = typeof TurnResult.Type;

/** What cron asks of the thing it starts: take a prompt, announce a finished turn. */
export const jobShape = Program.shape({in: {prompt: PromptPayload}, out: {result: TurnResult}});

const args = programArgs("cron", {job: jobShape});

/** One finished (or running) run, as the tile reports it. */
export interface CronRun {
	readonly startedAt: number;
	readonly ok: boolean;
	readonly summary: string;
}

export interface CronState {
	/** The job process this run started, or `null` when nothing is running. */
	readonly child: ProcessId | null;
	readonly startedAt: number | null;
	/** Newest first, bounded at `HISTORY`: a tile reads the tail, and nothing else reads it at all. */
	readonly runs: ReadonlyArray<CronRun>;
	readonly ticks: number;
}

/** How many runs the history keeps. Bounded because an unbounded log in state is a leak with a name. */
export const HISTORY = 10;

export interface CronOptions {
	/** Wake this often; `null` wakes only when told to, which is what the tests and `:cron run` want. */
	readonly everyMs: number | null;
	/** What the job is asked, every time cron wakes. */
	readonly prompt: string;
	/** The clock, so a test can state the time instead of reading one. */
	readonly now?: () => number;
}

const clock = (options: CronOptions): (() => number) => options.now ?? Date.now;

const hhmmss = (at: number): string => new Date(at).toTimeString().slice(0, 8);
const hhmm = (at: number): string => new Date(at).toTimeString().slice(0, 5);

/** `every 60s` for a whole number of seconds, `every 90000ms` for anything else, `on demand` for none. */
const cadence = (everyMs: number | null): string =>
	everyMs === null
		? "on demand"
		: everyMs % 1000 === 0
			? `every ${everyMs / 1000}s`
			: `every ${everyMs}ms`;

/** The first line of the job's answer, which is the whole of what a one-line tile can hold. */
const firstLine = (text: string): string => (text.split("\n")[0] ?? "").trim();

/** The history with one more run at its head, bounded. Both cells that record a run agree here. */
const recorded = (runs: ReadonlyArray<CronRun>, run: CronRun): ReadonlyArray<CronRun> =>
	[run, ...runs].slice(0, HISTORY);

/** The timer, as Demlik's dep-keyed Sub. Re-keyed on `everyMs`, so nothing restarts it per tick. */
const timer = (
	everyMs: number | null,
): ReadonlyArray<DepKeyedSub<CronState, AuthoredEvent, unknown>> =>
	everyMs === null
		? []
		: [
				{
					deps: () => ({everyMs}),
					source: (_state, dispatch) => {
						const handle = setInterval(() => dispatch({type: "tick"}), everyMs);
						return () => clearInterval(handle);
					},
				},
			];

/**
 * The authored record, over one set of options. A function rather than a constant because the
 * prompt text and the cadence are the config's to state, and both are read inside `update`.
 */
export const cronProgram = (options: CronOptions) => {
	const now = clock(options);
	return {
		id: "cron",
		args,
		init: (): CronState => ({child: null, startedAt: null, runs: [], ticks: 0}),
		update: {
			/**
			 * Wake. A tick landing while a job is still running is dropped rather than queued: cron
			 * reports one run at a time, and two live children would give it two `result`s to
			 * reconcile against one tile.
			 */
			tick: (state: CronState, _event: AuthoredEvent): Answer<CronState> => [
				{...state, ticks: state.ticks + 1},
				state.child === null ? [spawn(args.job, {on: {result: "result"}})] : [],
			],
			/** The job started. Record it, stamp the run's clock, and ask it the question. */
			spawned: (state: CronState, event: Spawned): Answer<CronState> => {
				const startedAt = now();
				return [
					{...state, child: event.process, startedAt},
					[
						send(
							{process: event.process, port: "prompt"},
							{text: options.prompt, key: `cron-${startedAt}`, timestamp: startedAt},
						),
					],
				];
			},
			/**
			 * The job answered. One entry at the head of the history, oldest dropped past `HISTORY` —
			 * and then the child is *stopped*, not waited on. An AI-agent session outlives its turn: it
			 * stays up holding a transcript, so a cron that cleared `child` only on `stopped` would
			 * never see one, drop every later tick, and leave the session to be restored on the next
			 * boot. The run is over when the answer lands, so cron ends it — and clears `child` here
			 * rather than on the `stopped` this `stop` answers with, so the very next tick may spawn.
			 */
			result: (state: CronState, event: Reply<"result", TurnResult>): Answer<CronState> => {
				const run: CronRun = {
					startedAt: state.startedAt ?? now(),
					ok: event.payload.ok,
					summary: firstLine(event.payload.text),
				};
				return [
					{...state, child: null, startedAt: null, runs: recorded(state.runs, run)},
					state.child === null ? [] : [stop(state.child)],
				];
			},
			/**
			 * A process ended. The child cron itself stopped is already off `child` by the time this
			 * lands, so what is left is the other case: the job died before it answered. That is a run,
			 * and a failed one — without it a crashed job would leave the tile reading the run before
			 * it, and `child` set forever.
			 */
			stopped: (state: CronState, event: Stopped): Answer<CronState> => {
				if (state.child === null || event.process !== state.child) {
					return [state, []];
				}
				const run: CronRun = {
					startedAt: state.startedAt ?? now(),
					ok: false,
					summary: "ended without answering",
				};
				return [{...state, child: null, startedAt: null, runs: recorded(state.runs, run)}, []];
			},
		},
		commands: {
			/**
			 * `:cron run` — one job, now. It answers a `spawn` and not a dispatched tick because a
			 * command is not a process step: its `Scope.process` is the *caller's* (ADR 0372), so
			 * there is no cron process here to send a tick to, and a command may not `emit` (#8766).
			 * The cost is stated where it is paid — the `spawned` a command's spawn answers is
			 * dropped by the spell interpreter, so a run started this way gets no prompt until an
			 * authored command can reach its own program's inbox.
			 */
			run: {
				args: Schema.Struct({}),
				describe: "run the job once, now",
				run: () => spawn(args.job, {on: {result: "result"}}),
			},
		},
		title: (_state: CronState): string => `cron · ${cadence(options.everyMs)}`,
		status: (state: CronState): string => {
			if (state.child !== null && state.startedAt !== null) {
				return `running since ${hhmmss(state.startedAt)}`;
			}
			const last = state.runs[0];
			return last === undefined
				? "idle"
				: `last run ${hhmm(last.startedAt)} · ${last.ok ? "ok" : "failed"}`;
		},
		subs: timer(options.everyMs),
	};
};

/**
 * A live session row, as a shaped arg's fill. It carries the row's own id, so the label and every
 * surface still name the real program, beside the two ports cron asked for re-declared in authoring
 * terms — see the header for why `shapeOf` cannot read them off the row itself.
 */
export const sessionAsJob = (row: AnyProgram): ShapeSource => ({
	id: row.id,
	ports: {prompt: port.in(PromptPayload), result: port.out(TurnResult)},
});

export interface CronFill extends CronOptions {
	readonly job: ShapeSource;
}

/**
 * The row, as a config writes it: `cron({everyMs, prompt, job})`. The `job` goes onto the row's
 * `fill` — the config call's half of `args` (#8762) — so the `spawn` in `tick` resolves the arg's
 * service key back to the program this row was built with, rather than asking the registry for
 * `tuval/arg/cron/job` and being told no such program exists. A `job` that does not fit `jobShape`
 * is refused here, at definition, by `defineProgram` itself.
 */
export const cron = (fill: CronFill): AnyProgram =>
	defineProgram({
		...cronProgram(fill),
		fill: {job: fill.job},
		label: `cron (${fill.job.id})`,
	});
