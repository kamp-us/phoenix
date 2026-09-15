/**
 * `cron` — a program that wakes on a timer, starts a *job* program, and says on its board tile how
 * that went. That is the whole of v1: it schedules, it reports, and it knows nothing else.
 *
 * The job arrives as an arg typed by its ports alone (`Program.shape`, #8716 R15.1), so this module
 * names no session and imports no session's package — which program fills it is
 * `.tuval/tuval.config.ts`'s call. Unlike the `pr-review` example, the shape is declared over the
 * *real* AI-agent payloads: `PromptPayloadSchema` and `TurnResultSchema` out of
 * `../ai-agent/ports/index.ts`, the interface module, not any agent's implementation — the same
 * import `authoring/example/pr-review.ts` makes, and what R15.1 asks for rather than what it
 * forbids. So a real Claude or Codex session is the kind of thing that fits the shape, and a config
 * hands the arg the shipped row itself.
 *
 * There was a `sessionAsJob` wrapper here, and it is gone. It existed because an AI-agent row's
 * ports were hand-written predicates with no schema beside them, so `shapeOf` (`../authoring/
 * shape.ts`) read a live session as `{in: {}, out: {}}` and no non-empty shape could fit one.
 * #8887 taught `shapeOf` to read a compiled row and #8959 gave those rows their payload schemas, so
 * `claudeSession({…})` now fits `jobShape` on its own — which is what `cron.unit.test.ts` pins,
 * where it used to pin the failure.
 *
 * **A job that ends before it answers reaches this program, and that is #9227, landed.** A child's
 * end is delivered to its spawner by the finalizer on the child's own Scope
 * (`../commands/core/process.ts`), and it is the only producer of `stopped`: cron's own `stop` in the
 * `result` cell and a job that crashed halfway both arrive at the one `stopped` cell below, which
 * tells them apart by whether the process named is still `child`. So a crashed job is written down
 * as a failed run on the spot instead of leaving `child` set and every later tick dropped until
 * `resume` reconciles it at the next boot. Nothing here works around anything.
 *
 * **`:cron run` reaches the cron the desk boots, and #8944 is what made that true.** A command may
 * only `send` (ADR 0372 as #8898 amended it), and a bare `send("run")` resolves to the declaring
 * program's own live process (`../authoring/own-process.ts`) off `ProcessTable` — so the resolution
 * finds the planned cron. Delivery then goes through `SpawnedProcesses.send`
 * (`../commands/core/process.ts`), whose table held only processes it had spawned itself until
 * #8944 gave `src/launch/` a way to enrol every graph node in that same table; the spell refused
 * with `UnknownProcess` before that and ticks now. Nothing in this file changed for it, which is
 * what writing the honest half rather than a workaround bought.
 */

import type {DepKeyedSub} from "@demlik/tea";
import {Schema} from "effect";
import {PromptPayloadSchema, type TurnResult, TurnResultSchema} from "../ai-agent/ports/index.ts";
import {programArgs} from "../authoring/args.ts";
import {type Answer, type AuthoredEvent, defineProgram} from "../authoring/define-program.ts";
import {
	type Reply,
	type SpawnEffect,
	type Spawned,
	type Stopped,
	send,
	spawn,
	stop,
} from "../authoring/effect.ts";
import {port} from "../authoring/port.ts";
import {Program, type ShapeSource} from "../authoring/shape.ts";
import type {ProcessId} from "../process/process.ts";
import type {AnyProgram} from "../registry/program.ts";

/** What cron asks of the thing it starts: take a prompt, announce a finished turn. */
export const jobShape = Program.shape({
	in: {prompt: PromptPayloadSchema},
	out: {result: TurnResultSchema},
});

const args = programArgs("cron", {job: jobShape});

/**
 * What `:cron run` puts on the `run` in-port. No fields, because "now" is the whole of the request —
 * the same empty struct the command declares its `args` over, so the command forwards exactly what
 * it was called with and nothing is invented between the two.
 */
export const RunRequest = Schema.Struct({});

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

/**
 * What a run a restart cut short is written down as. A restart is not an answer, so the run it
 * interrupted is a failed one, and the summary says which failure it was.
 */
export const INTERRUPTED = "interrupted by restart";

/** The first line of the job's answer, which is the whole of what a one-line tile can hold. */
const firstLine = (text: string): string => (text.split("\n")[0] ?? "").trim();

/** The history with one more run at its head, bounded. Both cells that record a run agree here. */
const recorded = (runs: ReadonlyArray<CronRun>, run: CronRun): ReadonlyArray<CronRun> =>
	[run, ...runs].slice(0, HISTORY);

/**
 * Start the job, or ask for nothing at all because one is already running. This is the whole of what
 * waking means, written once because two cells wake cron: the timer's `tick`, and the `run` port
 * `:cron run` writes to. A wake landing mid-run is dropped rather than queued — cron reports one run
 * at a time, and two live children would give it two `result`s to reconcile against one tile.
 * Nothing is recorded for the drop, because `status` already reads "running since", which is the
 * honest answer to "what happened when I asked".
 */
const startIfIdle = (state: CronState): ReadonlyArray<SpawnEffect> =>
	state.child === null ? [spawn(args.job, {on: {result: "result"}})] : [];

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
		/**
		 * One in-port, and it exists so `:cron run` has somewhere to land. A command may only `send`
		 * (ADR 0372 as #8898 amended it), so an on-demand run is a payload on a port whose cell
		 * decides what to do with it — never a dispatched `tick`, which is the timer's alone.
		 */
		ports: {run: port.in(RunRequest)},
		init: (): CronState => ({child: null, startedAt: null, runs: [], ticks: 0}),
		update: {
			/** The timer woke. `ticks` counts what the timer did, so it is moved only here. */
			tick: (state: CronState, _event: AuthoredEvent): Answer<CronState> => [
				{...state, ticks: state.ticks + 1},
				startIfIdle(state),
			],
			/**
			 * Someone asked for a run, now — `:cron run`'s payload landing on the `run` in-port. The
			 * same wake the timer's is, and deliberately so: one job if idle, nothing at all if one is
			 * already up. No state moves either way, because an on-demand run is not a tick and a
			 * refused one is not a run; the run itself reaches `runs` when its answer does, like any
			 * other.
			 */
			run: (state: CronState, _event: AuthoredEvent): Answer<CronState> => [
				state,
				startIfIdle(state),
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
			 * rather than on the `stopped` that `stop` will bring back, so the very next tick may spawn.
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
			 * The job ended. Every ending arrives here — cron's own `stop` from the `result` cell and a
			 * job that died halfway — because a child's end has one producer (#9227,
			 * `../commands/core/process.ts`). What tells them apart is `child`, and nothing else has to:
			 * the `result` cell clears `child` before it issues its `stop`, so the ordinary end of a turn
			 * names a process that is already off state and is a no-op here.
			 *
			 * The named process still being `child` therefore means exactly one thing — the job ended
			 * before it answered — and that is the run this cell writes down as failed. `child` is
			 * cleared with it, so the next tick spawns instead of being dropped for ever.
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
			/**
			 * Cron came back from a checkpoint holding a `child`, which means a restart cut a run in
			 * half. The run is over — whether or not the OS still has that process — so it is written
			 * down as failed and `child` is cleared, and the next tick spawns instead of being dropped
			 * for ever against a job that will never answer (#9220's neighbour).
			 *
			 * **A restored child cannot answer, even when it is live.** `../durability/restore.ts`
			 * spawns a checkpointed process through `Processes.spawn` directly: no `on` record, which
			 * is where the spawner's routing lives (`../commands/core/process.ts`), and a
			 * `ProcessPorts` that is `unwired`. So a restored session's `result` fails `PortNotWired`
			 * at its own emit and reaches no cron. Waiting on it is waiting on nothing.
			 *
			 * **And cron may not reap it.** `stop`/`send`/`ask` all fail `ProcessNotFound` on a process
			 * that is not live, an authored effect's failure propagates out of `dispatch`
			 * (`../host/actor.ts` `runInterpret`), and `../durability/resume.ts` catches none — so a
			 * blind `stop` here would fail *boot* in exactly the case this cell exists for: a child the
			 * manifest did not bring back, which is every child whose own checkpoint its row refused
			 * (`../ai-agent/program.ts` `restorable`) and every child at all once #9220 lands. Nothing
			 * in the authoring vocabulary reads the process table, so cron records the run and leaves
			 * the orphan to the kernel that restored it.
			 */
			restored: (state: CronState, _event: AuthoredEvent): Answer<CronState> => {
				if (state.child === null) return [state, []];
				const run: CronRun = {
					startedAt: state.startedAt ?? now(),
					ok: false,
					summary: INTERRUPTED,
				};
				return [{...state, child: null, startedAt: null, runs: recorded(state.runs, run)}, []];
			},
		},
		/**
		 * The one door a restarted cron has back into the world (`../authoring/resume.ts`): a restored
		 * process starts on its loaded state with no Cmds, so without this the half-finished run above
		 * is never reconciled. A checkpoint with no `child` has nothing to reconcile and is sent
		 * nothing.
		 */
		resume: (state: CronState) => (state.child === null ? [] : [{type: "restored" as const}]),
		commands: {
			/**
			 * `:cron run` — one job, now. A bare `send` and nothing else: a command may ask for no
			 * other effect (ADR 0372 as #8898 amended it), and the bare port name is what makes this
			 * honest rather than a second spawner. The call resolves to cron's own live process
			 * (`../authoring/own-process.ts`), the payload lands on the `run` port above, and the cell
			 * that owns it decides — which is how an on-demand run is the same run a tick is, prompt
			 * and all, instead of a parentless child nobody ever speaks to.
			 *
			 * It works against the cron the desk actually boots, which it did not before #8944:
			 * `src/launch/` now enrols every graph node in the same `SpawnedProcesses` table the send
			 * lands through, so the planned cron is addressable by the id its own resolution found.
			 */
			run: {
				args: RunRequest,
				describe: "run the job once, now",
				run: (request: typeof RunRequest.Type) => send("run", request),
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
