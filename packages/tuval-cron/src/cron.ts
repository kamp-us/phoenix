/**
 * `cron` — a program that wakes on a timer, starts a *job* program, says on its board tile how that
 * went, and announces the finished turn on an out-port so something downstream can have it. That is
 * the whole of it: it schedules, it reports, it hands the answer on, and it knows nothing else.
 *
 * **The `brief` out-port is the third of those, and it is new.** Until it existed cron's only
 * out-ports were the kernel's own `title@1`/`status@1`: the job's answer reached the `result` *cell*
 * — an arrival, routed from the child — and stopped there, folded into a one-line `summary` on the
 * tile. Nothing outside the process could have the turn itself, so a notifier, another program's
 * window, or a `graph` route had nothing to be wired to. `brief` carries the whole `TurnResult`, ok
 * or not, emitted from the same cell that writes the run down. The name is `brief` and not `result`
 * because `result` is already twice spoken for here — the cell the child's reply lands on, and
 * `jobShape`'s own out-port — and a reader should not have to work out which of the three a line
 * means.
 *
 * **Only a real turn leaves through it.** The two cells that record a run without one — `stopped`
 * for a job that died before answering, `restored` for a run a restart cut in half — emit nothing,
 * because there is no `TurnResult` to emit and inventing one (`ok: false`, empty text) would put a
 * brief on the wire that no job ever wrote. A consumer that wants to know a run failed reads
 * `payload.ok` on the briefs it does get; a consumer that wants to know a run *vanished* is asking
 * for something this port does not carry, and should say so rather than be answered with a forgery.
 *
 * **This file lives outside Tuval.** It began beside the kernel, in `apps/tuval/src/cron/` of
 * `kamp-us/phoenix`, and it is here now — a separate npm package, in a separate repo, owned by
 * someone who is not the kernel's author. Nothing in it reaches into Tuval's source: every name it
 * imports comes through one of the three published doors (#8943) — `@kampus/tuval/authoring`,
 * `@kampus/tuval/ai-agent/ports`, `@kampus/tuval/sessions` — which is the point of it being here.
 * A program a third party can write is only proven by a program a third party did write, from
 * outside, against the door and nothing else.
 *
 * The job arrives as an arg typed by its ports alone (`Program.shape`, #8716 R15.1), so this module
 * names no session and imports no session's package — which program fills it is
 * `.tuval/tuval.config.ts`'s call. The shape is declared over the *real* AI-agent payloads:
 * `PromptPayloadSchema` and `TurnResultSchema` out of `@kampus/tuval/ai-agent/ports`, the interface
 * module, not any agent's implementation — what R15.1 asks for rather than what it forbids. So a
 * real Claude or Codex session is the kind of thing that fits the shape, and a config hands the arg
 * the shipped row itself.
 *
 * There was a `sessionAsJob` wrapper in the original, and it is gone. It existed because an
 * AI-agent row's ports were hand-written predicates with no schema beside them, so Tuval's
 * `shapeOf` read a live session as `{in: {}, out: {}}` and no non-empty shape could fit one. #8887
 * taught `shapeOf` to read a compiled row and #8959 gave those rows their payload schemas, so
 * `claudeSession({…})` now fits `jobShape` on its own — which is what `cron.unit.test.ts` pins,
 * where it used to pin the failure.
 *
 * **A job that ends before it answers reaches this program, and that is #9227, landed.** A child's
 * end is delivered to its spawner by the finalizer on the child's own Scope, inside the kernel, and
 * it is the only producer of `stopped`: cron's own `stop` in the `result` cell and a job that
 * crashed halfway both arrive at the one `stopped` cell below, which tells them apart by whether
 * the process named is still `child`. So a crashed job is written down as a failed run on the spot
 * instead of leaving `child` set and every later tick dropped until `resume` reconciles it at the
 * next boot. Nothing here works around anything.
 *
 * **`:cron run` reaches the cron the desk boots, and #8944 is what made that true.** A command may
 * only `send` (ADR 0372 as #8898 amended it), and a bare `send("run")` resolves to the declaring
 * program's own live process off the kernel's `ProcessTable` — so the resolution finds the planned
 * cron. Delivery then goes through `SpawnedProcesses.send`, whose table held only processes it had
 * spawned itself until #8944 gave Tuval's launch path a way to enrol every graph node in that same
 * table; the spell refused with `UnknownProcess` before that and ticks now. Nothing in this file
 * changed for it, which is what writing the honest half rather than a workaround bought.
 */

import type { DepKeyedSub } from "@demlik/tea";
import {
  PromptPayloadSchema,
  type TurnResult,
  TurnResultSchema,
} from "@kampus/tuval/ai-agent/ports";
import {
  type Answer,
  type AnyProgram,
  type ArgRefs,
  type AuthoredEvent,
  defineProgram,
  emit,
  Program,
  port,
  programArgs,
  type Reply,
  type ShapeSource,
  type SpawnEffect,
  type Spawned,
  type Stopped,
  send,
  spawn,
  stop,
} from "@kampus/tuval/authoring";
import { Schema } from "effect";
import { CRON_WINDOW_REF } from "./renderer-ref.ts";
import {
  armSchedule,
  humanize,
  parseSchedule,
  type Schedule,
} from "./schedule.ts";
import {
  type CronRun,
  type CronState,
  INTERRUPTED,
  recorded,
  statusLine,
} from "./state.ts";

/** What cron asks of the thing it starts: take a prompt, announce a finished turn. */
export const jobShape = Program.shape({
  in: { prompt: PromptPayloadSchema },
  out: { result: TurnResultSchema },
});

/**
 * The declared args, named. `programArgs`' return type is `ArgRefs`, which
 * `@kampus/tuval/authoring` publishes (#9250) together with the `ArgRef`/`ProgramArgRef`/
 * `Spawnable` chain under it — so the declaration emit for `cronProgram` can write this type down
 * through the door rather than through a `node_modules` path it would refuse (TS2742).
 */
export type CronArgs = ArgRefs<string, { readonly job: typeof jobShape }>;

/**
 * One cron's args, keyed on *that* cron's id. Keyed rather than shared because an arg's service key
 * is `tuval/arg/<program>/<name>`: two crons over one key would read one another's `job` fill, and
 * the second config line would quietly decide what the first one runs. The id is `string` and not a
 * literal because it is the config's word, chosen at the call — every use of these refs is by name
 * (`args.job`), so nothing downstream wanted the literal.
 */
const argsFor = (id: string): CronArgs => programArgs(id, { job: jobShape });

/** The id a cron takes when a config does not name one — the single-cron config, unchanged. */
export const DEFAULT_ID = "cron";

/**
 * The id, checked. Tuval's `ProgramId` is a type-only brand — a plain string at runtime, and not
 * published through the authoring door — so there is no validator to borrow and this is the whole
 * of the refusal: an id must be a non-empty word with no whitespace in it, because it is also a
 * graph node id and the first token of a spell (`:morning-brief run`), and `:morning brief run`
 * addresses nothing. Refused here, at `cron(...)`, where the config is being written.
 */
const checkedId = (id: string | undefined): string => {
  if (id === undefined) return DEFAULT_ID;
  if (id.trim() === "" || /\s/.test(id)) {
    throw new Error(
      `cron: \`id\` must be a non-empty word with no spaces — it is the program id, the graph node id and the spell (\`:${id} run\`): ${JSON.stringify(id)}`,
    );
  }
  return id;
};

/**
 * What `:<id> run` puts on the `run` in-port. No fields, because "now" is the whole of the request —
 * the same empty struct the command declares its `args` over, so the command forwards exactly what
 * it was called with and nothing is invented between the two.
 */
export const RunRequest = Schema.Struct({});

/**
 * The name of the out-port a finished turn leaves on. A constant because it is spoken in three
 * places — the declaration, the `emit` in the `result` cell, and a config's `graph` route — and a
 * route wired to a typo is a route that silently never fires.
 */
export const BRIEF_PORT = "brief";

/** What every cron takes, whichever way it is woken. */
interface CronCommon {
  /**
   * What this cron is called: its program id, its graph node id, and the spell that runs it now
   * (`:morning-brief run`). Defaults to `"cron"`, so a config with one cron writes nothing here —
   * and a config with a morning brief and an evening summary gives each its own word, because two
   * rows under one id collide on all three at once.
   */
  readonly id?: string;
  /** What the job is asked, every time cron wakes. */
  readonly prompt: string;
  /** The clock, so a test can state the time instead of reading one. */
  readonly now?: () => number;
}

/** Wake on a fixed interval, or — with `null` — only when told to. */
export interface CronInterval extends CronCommon {
  readonly everyMs: number | null;
  readonly schedule?: never;
}

/** Wake on a 5-field cron expression, read in local time. */
export interface CronSchedule extends CronCommon {
  readonly schedule: string;
  readonly everyMs?: never;
}

/**
 * How cron is woken, as a union rather than two optional fields, so *both at once* is a type error
 * before it is a runtime one. Three shapes and no fourth: `{everyMs: number}` ticks on an interval,
 * `{schedule: "0 7 * * *"}` fires on a cron expression in local time, `{everyMs: null}` never wakes
 * itself at all and waits for `:cron run`.
 */
export type CronOptions = CronInterval | CronSchedule;

const clock = (options: CronOptions): (() => number) => options.now ?? Date.now;

/**
 * The one reading of the options, made once. `everyMs` and `schedule` are mutually exclusive in the
 * type; this is the runtime half of the same refusal, for a config written in JavaScript or built
 * out of a spread the checker could not see through — and it is where a malformed expression is
 * refused too, at `cron(...)` rather than at the first tick on a desk nobody is watching. The same
 * place and the same manner `defineProgram` refuses a `job` that does not fit `jobShape`.
 */
const waking = (
  options: CronOptions,
): { readonly everyMs: number | null; readonly schedule: Schedule | null } => {
  const everyMs = options.everyMs;
  const schedule = options.schedule;
  if (everyMs !== undefined && schedule !== undefined) {
    throw new Error(
      "cron: give `everyMs` or `schedule`, never both — one program has one clock",
    );
  }
  if (schedule !== undefined) {
    return { everyMs: null, schedule: parseSchedule(schedule) };
  }
  if (everyMs === undefined) {
    throw new Error(
      "cron: give `everyMs` (a number, or `null` for on-demand) or `schedule` (a cron expression)",
    );
  }
  return { everyMs, schedule: null };
};

/**
 * What the tile calls this cron's clock: `daily 07:00` or `0 9 * * 1-5` for a schedule, `every 60s`
 * for a whole number of seconds, `every 90000ms` for anything else, `on demand` for none.
 */
const cadence = (woken: {
  readonly everyMs: number | null;
  readonly schedule: Schedule | null;
}): string => {
  if (woken.schedule !== null) return humanize(woken.schedule.expression);
  const everyMs = woken.everyMs;
  return everyMs === null
    ? "on demand"
    : everyMs % 1000 === 0
      ? `every ${everyMs / 1000}s`
      : `every ${everyMs}ms`;
};

/** The first line of the job's answer, which is the whole of what a one-line tile can hold. */
const firstLine = (text: string): string => (text.split("\n")[0] ?? "").trim();

/**
 * Start the job, or ask for nothing at all because one is already running. This is the whole of what
 * waking means, written once because two cells wake cron: the timer's `tick`, and the `run` port
 * `:<id> run` writes to. A wake landing mid-run is dropped rather than queued — cron reports one run
 * at a time, and two live children would give it two `result`s to reconcile against one tile.
 * Nothing is recorded for the drop, because `status` already reads "running since", which is the
 * honest answer to "what happened when I asked".
 *
 * The args come in rather than off the module, because they are this cron's and not every cron's.
 */
const startIfIdle = (
  state: CronState,
  args: CronArgs,
): ReadonlyArray<SpawnEffect> =>
  state.child === null ? [spawn(args.job, { on: { result: "result" } })] : [];

/**
 * The timer, as Demlik's dep-keyed Sub. One of three: a `setInterval` on `everyMs`, a re-arming
 * one-shot on a cron expression, or nothing at all for an on-demand cron. Each is keyed on the one
 * thing that defines it — the interval, or the expression string — so nothing restarts it per tick.
 */
const timer = (
  woken: {
    readonly everyMs: number | null;
    readonly schedule: Schedule | null;
  },
  now: () => number,
): ReadonlyArray<DepKeyedSub<CronState, AuthoredEvent, unknown>> => {
  const schedule = woken.schedule;
  if (schedule !== null) {
    return [
      {
        deps: () => ({ schedule: schedule.expression }),
        source: (_state, dispatch) =>
          armSchedule(schedule, now, () => dispatch({ type: "tick" })),
      },
    ];
  }
  const everyMs = woken.everyMs;
  if (everyMs === null) return [];
  return [
    {
      deps: () => ({ everyMs }),
      source: (_state, dispatch) => {
        const handle = setInterval(() => dispatch({ type: "tick" }), everyMs);
        return () => clearInterval(handle);
      },
    },
  ];
};

/**
 * The authored record, over one set of options. A function rather than a constant because the
 * prompt text and the cadence are the config's to state, and both are read inside `update`.
 */
export const cronProgram = (options: CronOptions) => {
  const now = clock(options);
  const woken = waking(options);
  const id = checkedId(options.id);
  const args = argsFor(id);
  return {
    id,
    args,
    /**
     * Two ports, one each way.
     *
     * `run` is in, and it exists so `:<id> run` has somewhere to land. A command may only `send`
     * (ADR 0372 as #8898 amended it), so an on-demand run is a payload on a port whose cell
     * decides what to do with it — never a dispatched `tick`, which is the timer's alone.
     *
     * `brief` is out, and it is how the job's answer leaves the process. Declared over
     * `TurnResultSchema` — the same shipped schema `jobShape` names on the job's side — so what
     * cron announces is exactly what the job announced, unwrapped and unsummarised, and a consumer
     * decodes it with the schema out of `@kampus/tuval/ai-agent/ports` rather than one of cron's
     * invention. The tile's `summary` is a *reading* of a brief; this is the brief.
     */
    ports: {
      run: port.in(RunRequest),
      [BRIEF_PORT]: port.out(TurnResultSchema),
    },
    /**
     * `id` and `cadence` are env rather than state — the config chose both and no cell moves
     * either — and they are seeded here because a window is handed one thing, this process's public
     * state, and the first line a person opening a cron wants is which cron it is and when it
     * fires. Without them `./window.tsx` could not say what it is looking at.
     */
    init: (): CronState => ({
      id,
      cadence: cadence(woken),
      child: null,
      startedAt: null,
      runs: [],
      ticks: 0,
    }),
    update: {
      /** The timer woke. `ticks` counts what the timer did, so it is moved only here. */
      tick: (state: CronState, _event: AuthoredEvent): Answer<CronState> => [
        { ...state, ticks: state.ticks + 1 },
        startIfIdle(state, args),
      ],
      /**
       * Someone asked for a run, now — `:<id> run`'s payload landing on the `run` in-port. The
       * same wake the timer's is, and deliberately so: one job if idle, nothing at all if one is
       * already up. No state moves either way, because an on-demand run is not a tick and a
       * refused one is not a run; the run itself reaches `runs` when its answer does, like any
       * other.
       */
      run: (state: CronState, _event: AuthoredEvent): Answer<CronState> => [
        state,
        startIfIdle(state, args),
      ],
      /** The job started. Record it, stamp the run's clock, and ask it the question. */
      spawned: (state: CronState, event: Spawned): Answer<CronState> => {
        const startedAt = now();
        return [
          { ...state, child: event.process, startedAt },
          [
            send(
              { process: event.process, port: "prompt" },
              {
                text: options.prompt,
                key: `${id}-${startedAt}`,
                timestamp: startedAt,
              },
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
       *
       * And the turn goes out on `brief`, from here, because here is where a run becomes a fact.
       * The payload is `event.payload` itself — the whole `TurnResult`, ok or failed, not the first
       * line the tile keeps — so a consumer reads `ok` and decides for itself what a failed turn is
       * worth. Emitted before the `stop`, so the brief leaves before cron starts reaping the
       * process that wrote it.
       */
      result: (
        state: CronState,
        event: Reply<"result", TurnResult>,
      ): Answer<CronState> => {
        const run: CronRun = {
          startedAt: state.startedAt ?? now(),
          ok: event.payload.ok,
          summary: firstLine(event.payload.text),
        };
        return [
          {
            ...state,
            child: null,
            startedAt: null,
            runs: recorded(state.runs, run),
          },
          [
            emit(BRIEF_PORT, event.payload),
            ...(state.child === null ? [] : [stop(state.child)]),
          ],
        ];
      },
      /**
       * The job ended. Every ending arrives here — cron's own `stop` from the `result` cell and a
       * job that died halfway — because a child's end has one producer (#9227, the finalizer on
       * the child's own Scope inside the kernel). What tells them apart is `child`, and nothing
       * else has to: the `result` cell clears `child` before it issues its `stop`, so the ordinary
       * end of a turn names a process that is already off state and is a no-op here.
       *
       * The named process still being `child` therefore means exactly one thing — the job ended
       * before it answered — and that is the run this cell writes down as failed. `child` is
       * cleared with it, so the next tick spawns instead of being dropped for ever.
       *
       * Nothing leaves on `brief` here. The run is real and the tile says it failed, but there is
       * no `TurnResult` — the job ended before it wrote one — and a fabricated empty turn would be
       * cron putting words in a job's mouth. Only real turns leave through `brief`.
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
        return [
          {
            ...state,
            child: null,
            startedAt: null,
            runs: recorded(state.runs, run),
          },
          [],
        ];
      },
      /**
       * Cron came back from a checkpoint holding a `child`, which means a restart cut a run in
       * half. The run is over — whether or not the OS still has that process — so it is written
       * down as failed and `child` is cleared, and the next tick spawns instead of being dropped
       * for ever against a job that will never answer (#9220's neighbour).
       *
       * **A restored child cannot answer, even when it is live.** Tuval's restore path spawns a
       * checkpointed process through `Processes.spawn` directly: no `on` record, which is where
       * the spawner's routing lives, and a `ProcessPorts` that is `unwired`. So a restored
       * session's `result` fails `PortNotWired` at its own emit and reaches no cron. Waiting on it
       * is waiting on nothing.
       *
       * **And cron may not reap it.** `stop`/`send`/`ask` all fail `ProcessNotFound` on a process
       * that is not live, an authored effect's failure propagates out of `dispatch`, and the
       * kernel's resume catches none — so a blind `stop` here would fail *boot* in exactly the
       * case this cell exists for: a child the manifest did not bring back, which is every child
       * whose own checkpoint its row refused and every child at all once #9220 lands. Nothing in
       * the authoring vocabulary reads the process table, so cron records the run and leaves the
       * orphan to the kernel that restored it.
       *
       * And nothing leaves on `brief`, for the same reason `stopped` emits nothing: a run cut in
       * half by a restart produced no `TurnResult`, and a restore is not a place to invent one.
       */
      restored: (
        state: CronState,
        _event: AuthoredEvent,
      ): Answer<CronState> => {
        // The config is the authority on `id` and `cadence`, and a checkpoint is not. Both are env
        // — no cell moves either — so a restore re-seeds them from the options this cron was just
        // built with: a checkpoint written before a config changed `schedule` would otherwise carry
        // the old cadence for ever, and one written before the window existed carries neither
        // field, which `isCronState` refuses and a window shows as its unreadable placeholder.
        const env = { id, cadence: cadence(woken) };
        if (state.child === null) return [{ ...state, ...env }, []];
        const run: CronRun = {
          startedAt: state.startedAt ?? now(),
          ok: false,
          summary: INTERRUPTED,
        };
        return [
          {
            ...state,
            ...env,
            child: null,
            startedAt: null,
            runs: recorded(state.runs, run),
          },
          [],
        ];
      },
    },
    /**
     * The one door a restarted cron has back into the world: a restored process starts on its
     * loaded state with no Cmds, so without this neither the half-finished run above nor the two
     * env fields beside it are ever reconciled. Every restore is sent one `restored`, whatever the
     * checkpoint holds — `id` and `cadence` belong to the config and have to be re-read on every
     * boot, and a checkpoint with no `child` is simply the cheap half of that cell.
     */
    resume: (_state: CronState) => [{ type: "restored" as const }],
    commands: {
      /**
       * `:<id> run` — one job, now: `:cron run` for the default id, `:morning-brief run` for a
       * cron the config named. The spell is the row's id because a spell is addressed to a
       * program, which is the whole reason two crons in one config need two ids. A bare `send` and nothing else: a command may ask for no
       * other effect (ADR 0372 as #8898 amended it), and the bare port name is what makes this
       * honest rather than a second spawner. The call resolves to cron's own live process, the
       * payload lands on the `run` port above, and the cell that owns it decides — which is how an
       * on-demand run is the same run a tick is, prompt and all, instead of a parentless child
       * nobody ever speaks to.
       *
       * It works against the cron the desk actually boots, which it did not before #8944: Tuval's
       * launch path now enrols every graph node in the same `SpawnedProcesses` table the send
       * lands through, so the planned cron is addressable by the id its own resolution found.
       */
      run: {
        args: RunRequest,
        describe: "run the job once, now",
        run: (request: typeof RunRequest.Type) => send("run", request),
      },
    },
    title: (_state: CronState): string => `${id} · ${cadence(woken)}`,
    /**
     * The tile's second line, drawn by `./state.ts` so the window draws the same sentence from the
     * same function rather than a second statement of it.
     */
    status: statusLine,
    subs: timer(woken, now),
  };
};

export type CronFill = CronOptions & { readonly job: ShapeSource };

/**
 * The row, as a config writes it: `cron({everyMs, prompt, job})`. The `job` goes onto the row's
 * `fill` — the config call's half of `args` (#8762) — so the `spawn` in `tick` resolves the arg's
 * service key back to the program this row was built with, rather than asking the registry for
 * `tuval/arg/cron/job` and being told no such program exists. A `job` that does not fit `jobShape`
 * is refused here, at definition, by `defineProgram` itself.
 */
export const cron = (fill: CronFill): AnyProgram => {
  const authored = cronProgram(fill);
  return {
    ...defineProgram({
      ...authored,
      fill: { job: fill.job },
      label: `${authored.id} (${fill.job.id})`,
    }),
    /**
     * The window, named rather than declared. `defineProgram` compiles an authored `window` field
     * into a `host-native` reference and seats the renderer in a map *inside the kernel process* —
     * and the page is a browser tab, so nothing over there can reach that map (kamp-us/phoenix
     * #8811, open). A `kind: "module"` reference is the route that does cross: the page loads the
     * specifier itself at boot and seats what comes back (ADR 0359). So the row carries the
     * specifier, and `./window.tsx` is what answers it.
     *
     * Spread onto the row rather than passed to `defineProgram`, because `renderer` is not a field
     * the authoring surface takes — `FIELD_COMPILERS` owns that key and computes it from `window`.
     * The row is a plain object and says so: "every field this layer does not sugar is still
     * reachable by spread".
     */
    renderer: CRON_WINDOW_REF,
  };
};
