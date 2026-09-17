/**
 * `workspace` — a program that hands each agent its own everything: a git worktree cut from a base
 * ref, a TCP port nothing else holds, an `.env` written from your template with that port in it,
 * and whatever setup command builds the rest (a scratch database, a compose project, a warmed nix
 * shell). One tile, one line per workspace, and `:workspace close <name>` puts all of it back.
 *
 * **The problem, stated once.** Two agents on one repository collide. Same worktree, so one
 * rebases under the other; same dev port, so the second server will not start; same `.env`, so a
 * changed variable is a changed variable for both; same local database, so one agent's migration
 * is the other's broken fixture. Conductor, Claude Squad and Cursor Mission Control each give you
 * the worktree and stop there — the port, the env file and the database are left to you, which is
 * to say left to collide. Declaring all four together, resolving them per workspace and disposing
 * of them together is the whole idea: nix-shell's argument, applied to agents.
 *
 * **Declared inputs, resolved once, in one order.** `./provision.ts` owns the order — worktree,
 * port, env, setup — and owns nothing else; it is handed a `Runner` and is otherwise pure, so the
 * suite for this package never runs `git`, never binds a port and never writes a file outside a
 * fake. What is left here is a state machine: what a name may be, what may happen while something
 * is in flight, and what a tile says about it.
 *
 * **The provisioning is an effect this program named, run by a handler it wrote.** An `update` cell
 * is pure and synchronous; `git worktree add` is neither. So a cell *answers an effect* — a plain
 * tagged value carrying the whole plan — and the actor hands that value to the handler this row was
 * spread with, which runs `./provision.ts` and answers the events the reducer already consumes:
 * `provisioned` or `provisionFailed`, `closed` or `closeFailed`, `reconciled`. One at a time,
 * because two concurrent `git worktree add` on one repository is not a thing to do and two
 * concurrent port probes would hand out the same port twice — which is what the `pending` mutex on
 * state is for, and it is the only reason it survives.
 *
 * **This is R12.1's seam, and it used to be a Sub.** Demlik's discipline says side effects live in
 * `interpret` and a Sub only observes (`.patterns/tea/tea-discipline.md`, invariant 3), so running
 * `git worktree add` from one was a disclosed violation held open for want of a seam: *"Effect
 * appears only when a user writes their own effect handler; the raw row is reachable by spread"*
 * (kamp-us/phoenix#8716, R12.1). kamp-us/phoenix#9295 shipped it — `defineProgram`'s sixth type
 * argument widens `Answer<S, X>` to the author's own effect, and `{...row, handlers: {...row.handlers,
 * …}}` is where its handler goes — so the Sub, the `Effect.runFork` bridge and the `Fiber.interrupt`
 * disposer are all gone. The reducer never moved: it was pure TEA before and it is pure TEA now.
 *
 * **The agent-inside half is honest about what it cannot do, and that is the whole of v1's caveat.**
 * A Tuval `spawn` carries a program id and an out-port routing table and nothing else
 * (`apps/tuval/src/authoring/effect.ts:111-118`); an AI-agent row's `cwd` is baked onto the
 * registry row at config time (`src/claude/program.ts:115` → `src/claude/agent/options.ts:135`) and
 * `claude-session`'s id is a constant, so one kernel holds one such row and one cwd. The one
 * per-spawn cwd mechanism the kernel has, `SessionOpening`, is produced by the shell picker and by
 * nothing an authored program can reach. Filed as kamp-us/phoenix#9287.
 *
 * So the session this program starts runs on the cwd your config gave `claudeSession`, and the
 * workspace's path reaches it **in words**: the prompt is prefixed with "You are working in
 * `<path>` on branch `<branch>`; dev port `<port>`." That is a sentence, not an invariant — an
 * agent that ignores it is not refused by anything — and it is named as the fallback it is, here
 * and in the README, rather than dressed up as isolation. Everything below the session is real:
 * the worktree exists, the port is held, the `.env` is written, the scratch database is made and
 * dropped.
 */

import { basename, join } from "node:path";
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
  type HostHandlers,
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
import { Effect, Schema } from "effect";
import {
  type Machine,
  machineLayer,
  type ProvisionPlan,
  type ProvisionStep,
  provision,
  reconcile,
  type TeardownPlan,
  type TeardownStage,
  teardown,
} from "./provision.ts";
import { WORKSPACE_WINDOW_REF } from "./renderer-ref.ts";
import { nodeRunner, type Runner } from "./runner.ts";
import {
  byName,
  isLive,
  LIMIT,
  NAME_PATTERN,
  type RefusalReason,
  recorded,
  refused,
  statusLine,
  takenPorts,
  unowned,
  type WorkspaceRecord,
  type WorkspaceState,
  without,
  withRecord,
} from "./state.ts";

/** What workspace asks of the agent it starts: take a prompt, announce a finished turn. */
export const jobShape = Program.shape({
  in: { prompt: PromptPayloadSchema },
  out: { result: TurnResultSchema },
});

/**
 * The declared args, named. `programArgs`' return type is `ArgRefs`, which the authoring door
 * publishes together with the `ArgRef`/`ProgramArgRef`/`Spawnable` chain under it — so the
 * declaration emit for `workspaceProgram` can write this type down through the door rather than
 * through a `node_modules` path it would refuse (TS2742).
 */
export type WorkspaceArgs = ArgRefs<string, { readonly job: typeof jobShape }>;

/**
 * One workspace program's args, keyed on *that* program's id. Keyed rather than shared because an
 * arg's service key is `tuval/arg/<program>/<name>`: two workspace rows over one key would read one
 * another's `job` fill, and the second config line would quietly decide what the first one runs.
 */
const argsFor = (id: string): WorkspaceArgs =>
  programArgs(id, { job: jobShape });

/** The id a workspace program takes when a config does not name one. */
export const DEFAULT_ID = "workspace";

/** The branch prefix a workspace's branch takes when a config does not name one. */
export const DEFAULT_BRANCH_PREFIX = "can/";

/** Where worktrees go, relative to the repository, when a config does not say. */
export const DEFAULT_ROOT = ".workspaces";

/** The base ref a new branch starts at, when a config does not say. */
export const DEFAULT_BASE = "origin/main";

/** The port range probed, when a config does not say. */
export const DEFAULT_PORTS = { from: 5170, to: 5199 } as const;

/** The env step, when a config does not say — and `env: false` is how a config says *none*. */
export const DEFAULT_ENV = {
  template: ".env.example",
  portKey: "PORT",
} as const;

/**
 * The id, checked. Tuval's `ProgramId` is a type-only brand — a plain string at runtime, and not
 * published through the authoring door — so there is no validator to borrow and this is the whole
 * of the refusal: an id must be a non-empty word with no whitespace in it, because it is also a
 * graph node id and the first token of a spell (`:workspace open`), and `:my workspace open`
 * addresses nothing. Refused at `workspace(...)`, where the config is being written.
 */
const checkedId = (id: string | undefined): string => {
  if (id === undefined) return DEFAULT_ID;
  if (id.trim() === "" || /\s/.test(id)) {
    throw new Error(
      `workspace: \`id\` must be a non-empty word with no spaces — it is the program id, the graph node id and the spell (\`:${id} open\`): ${JSON.stringify(id)}`,
    );
  }
  return id;
};

/** The env step a config asked for, normalised — or `null` for a config that asked for none. */
export interface EnvOptions {
  /** The template to copy, relative to the repository root. */
  readonly template?: string;

  /** The key the chosen port is written to. */
  readonly portKey?: string;

  /**
   * Anything else to write, with `$NAME`/`$PORT`/`$WORKTREE`/`$BRANCH` resolved first. This is where a
   * `DATABASE_URL` that embeds the workspace's name goes.
   */
  readonly vars?: Readonly<Record<string, string>>;

  /** What the written file is called inside the worktree. `.env` unless you say otherwise. */
  readonly file?: string;
}

/** What a config writes. Everything but `repo` has a default, and every default is named above. */
export interface WorkspaceOptions {
  /** What this program is called: its program id, its graph node id, and its two spells. */
  readonly id?: string;

  /** The repository worktrees are cut from, absolute. The one field with no default. */
  readonly repo: string;

  /** The ref a new workspace's branch starts at. `origin/main` by default. */
  readonly base?: string;

  /** Where worktrees go. Relative paths are resolved against `repo`. `.workspaces` by default. */
  readonly root?: string;

  /** What a workspace's branch is called: this, then the name. `can/` by default. */
  readonly branchPrefix?: string;

  /** The range probed for a free port. */
  readonly port?: { readonly from: number; readonly to: number };

  /** The env step, or `false` for a repository that has no env file to copy. */
  readonly env?: EnvOptions | false;

  /** Commands run inside a fresh worktree, in order, with the four variables resolved. */
  readonly setup?: ReadonlyArray<string>;

  /** Commands run inside a workspace before it is removed, in order, same variables. */
  readonly teardown?: ReadonlyArray<string>;

  /** Extra sentences appended to the where-you-are preface every agent is sent. */
  readonly brief?: string;

  /** The clock, so a test can state the time instead of reading one. */
  readonly now?: () => number;

  /** The machine. Injected so a test never touches git, a port, or the disk. */
  readonly runner?: Runner;
}

/** The row, as a config writes it. `job` is optional: a workspace with none only provisions. */
export type WorkspaceFill = WorkspaceOptions & {
  readonly job?: ShapeSource;
};

/**
 * The options with every default applied — one reading, made once at `workspace(...)`.
 *
 * Exported, together with `settle`, `freshRecord`, `openPlan` and `closePlan` below, because the
 * examples' suite drives the five personas through *this* derivation rather than restating it. A
 * test that rebuilds the plan by hand is a test that passes while the program does something else.
 */
export interface Settled {
  readonly id: string;
  readonly repo: string;
  readonly repoName: string;
  readonly root: string;
  readonly base: string;
  readonly branchPrefix: string;
  readonly ports: { readonly from: number; readonly to: number };
  readonly env: {
    readonly template: string;
    readonly portKey: string;
    readonly vars: Readonly<Record<string, string>>;
    readonly file: string;
  } | null;
  readonly setup: ReadonlyArray<string>;
  readonly teardown: ReadonlyArray<string>;
  readonly brief: string;
  readonly now: () => number;
  readonly runner: Runner;
  readonly hasJob: boolean;
}

export const settle = (options: WorkspaceFill): Settled => {
  if (options.repo.trim() === "") {
    throw new Error(
      "workspace: `repo` is the repository worktrees are cut from; it cannot be empty",
    );
  }
  const range = options.port ?? DEFAULT_PORTS;
  if (range.from > range.to) {
    throw new Error(
      `workspace: \`port\` must run upwards — got {from: ${range.from}, to: ${range.to}}`,
    );
  }
  const env = options.env;
  const root = options.root ?? DEFAULT_ROOT;
  return {
    id: checkedId(options.id),
    repo: options.repo,
    repoName: basename(options.repo),
    root: root.startsWith("/") ? root : join(options.repo, root),
    base: options.base ?? DEFAULT_BASE,
    branchPrefix: options.branchPrefix ?? DEFAULT_BRANCH_PREFIX,
    ports: range,
    env:
      env === false
        ? null
        : {
            template: env?.template ?? DEFAULT_ENV.template,
            portKey: env?.portKey ?? DEFAULT_ENV.portKey,
            vars: env?.vars ?? {},
            file: env?.file ?? ".env",
          },
    setup: options.setup ?? [],
    teardown: options.teardown ?? [],
    brief: options.brief ?? "",
    now: options.now ?? Date.now,
    runner: options.runner ?? nodeRunner(),
    hasJob: options.job !== undefined,
  };
};

/**
 * What `:<id> open <name> [brief]` puts on the `open` in-port. Two fields in declaration order,
 * because that order *is* the positional order of a spell's parameters — `name` first, so
 * `:workspace open feature-x` is the whole of the common call.
 */
export const OpenRequest = Schema.Struct({
  name: Schema.String,
  brief: Schema.optional(Schema.String),
});

/** What `:<id> close <name>` puts on the `close` in-port. */
export const CloseRequest = Schema.Struct({
  name: Schema.String,
});

/**
 * What `:<id> discard <name>` puts on the `discard` in-port — the same one field, because the only
 * difference between the two spells is what they are called and what that name promises.
 */
export const DiscardRequest = Schema.Struct({
  name: Schema.String,
});

/**
 * The three spells' argument types, named. Written down rather than inferred because `X` — the
 * effect type this program answers — is not an inference site (kamp-us/phoenix#9295), so the whole
 * type-argument list has to be stated at `defineProgram` and every earlier argument with it.
 */
export type WorkspaceCommands = {
  readonly open: typeof OpenRequest.Type;
  readonly close: typeof CloseRequest.Type;
  readonly discard: typeof DiscardRequest.Type;
};

// -- The derivation, shared by the program and its tests ---------------------

/** A workspace, before anything has been provisioned into it. */
export const freshRecord = (
  settled: Settled,
  name: string,
): WorkspaceRecord => ({
  name,
  path: join(settled.root, name),
  branch: `${settled.branchPrefix}${name}`,
  port: null,
  status: "provisioning",
  agent: null,
  detail: null,
  openedAt: settled.now(),
});

/** What one `open` asks of `./provision.ts`, derived from the settled config and the record. */
export const openPlan = (
  settled: Settled,
  record: WorkspaceRecord,
  taken: ReadonlyArray<number>,
): ProvisionPlan => ({
  name: record.name,
  repo: settled.repo,
  path: record.path,
  branch: record.branch,
  base: settled.base,
  ports: settled.ports,
  taken,
  env: settled.env,
  setup: settled.setup,
});

/**
 * What one `close` asks of `./provision.ts`. `force` is a parameter rather than a config field
 * because it is a per-call decision: the same workspace closes safely under `:<id> close` and
 * forcibly under `:<id> discard`, and nothing in a config should be able to make the first one
 * behave like the second.
 */
export const closePlan = (
  settled: Settled,
  record: WorkspaceRecord,
  force: boolean,
): TeardownPlan => ({
  name: record.name,
  repo: settled.repo,
  path: record.path,
  branch: record.branch,
  port: record.port,
  commands: settled.teardown,
  force,
});

// -- The events a handler answers with --------------------------------------

interface Provisioned extends AuthoredEvent {
  readonly type: "provisioned";
  readonly name: string;
  readonly port: number;
}

interface ProvisionFailed extends AuthoredEvent {
  readonly type: "provisionFailed";
  readonly name: string;
  readonly step: ProvisionStep;
  readonly detail: string;
}

interface Closed extends AuthoredEvent {
  readonly type: "closed";
  readonly name: string;
}

interface CloseFailed extends AuthoredEvent {
  readonly type: "closeFailed";
  readonly name: string;

  /** Which half refused: a `teardown` command the config wrote, or git's own `remove`. */
  readonly stage: TeardownStage;
  readonly detail: string;
}

interface Reconciled extends AuthoredEvent {
  readonly type: "reconciled";
  readonly missing: ReadonlyArray<string>;
}

/** The whole vocabulary a handler speaks back, named so a test can build one without guessing. */
export type WorkspaceEvent =
  | Provisioned
  | ProvisionFailed
  | Closed
  | CloseFailed
  | Reconciled;

// -- The effects this program named, which is R12.1's seam -------------------

/**
 * **Three effects of this program's own, and why they are three.**
 *
 * A Tuval effect is plain tagged data discriminated on `type` — the actor looks a handler up by
 * `cmd.type` and nothing else (`apps/tuval/src/host/actor.ts`, `src/process/Processes.ts`) — so
 * these are records, not classes, and their tags are namespaced for the reason `aiAgent.start` is:
 * the handler record is one flat map keyed by string, shared with the six the kernel wrote.
 *
 * **Each one carries a whole plan, resolved.** A handler is handed its effect and nothing else: no
 * state, no config, no lookup. So the cell that answers an effect is the cell that derives it —
 * `openPlan`/`closePlan` run *there*, while the record and the taken ports are still in hand — and
 * a handler is a function of its argument. That closes the one race the Sub had by construction:
 * there is no window between "queued" and "run" in which the record could go away, so the branch
 * that used to answer `null` for a vanished record does not exist any more.
 */
export interface Provision {
  readonly type: "workspace.provision";
  readonly plan: ProvisionPlan;
}

/** One workspace put back: teardown commands, then the removal, forced only by `discard`. */
export interface Teardown {
  readonly type: "workspace.teardown";
  readonly plan: TeardownPlan;
}

/**
 * Every recorded workspace, checked against disk. A read, but a read of the world — it belongs on
 * this side of the seam with the other two rather than in a Sub, because it happens once in answer
 * to an event (`restored`) rather than standing open observing anything.
 */
export interface Reconcile {
  readonly type: "workspace.reconcile";
  readonly records: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
  }>;
}

/** `defineProgram`'s sixth type argument, and the key set the spread handlers answer. */
export type WorkspaceEffect = Provision | Teardown | Reconcile;

export const provisionEffect = (plan: ProvisionPlan): Provision => ({
  type: "workspace.provision",
  plan,
});

export const teardownEffect = (plan: TeardownPlan): Teardown => ({
  type: "workspace.teardown",
  plan,
});

export const reconcileEffect = (records: Reconcile["records"]): Reconcile => ({
  type: "workspace.reconcile",
  records,
});

/**
 * The where-you-are preface. Built here rather than in the config because every word of it is a
 * fact this program resolved, and because it is the fallback for phoenix#9287 — a session whose
 * process cwd this program could not set is told, in the one channel it does have, where its work
 * actually lives.
 */
export const preface = (record: WorkspaceRecord, brief: string): string => {
  const port = record.port === null ? "no dev port" : `dev port ${record.port}`;
  const head = `You are working in ${record.path} on branch ${record.branch}; ${port}. Start by changing into that directory — it is a git worktree of its own and it is not where this session started.`;
  return brief.trim() === "" ? head : `${head}\n\n${brief.trim()}`;
};

/**
 * Start the agent inside a provisioned workspace, or ask for nothing because the config filled no
 * `job`. Written once because one place decides it and the `provisioned` cell is that place.
 */
const startAgent = (
  settled: Settled,
  args: WorkspaceArgs,
): ReadonlyArray<SpawnEffect> =>
  settled.hasJob ? [spawn(args.job, { on: { result: "result" } })] : [];

/**
 * **The three handlers, which is where this package's work actually happens.**
 *
 * A `HostHandlers` handler is `(effect) => Effect<ReadonlyArray<Msg>, E, R>` — its follow-ups as a
 * *list*, one entry or none, never a bare Msg — and the actor dispatches every entry back into this
 * same process's inbox, where the `update` cell of that name takes it. So these three are the whole
 * of the round trip: an effect in, `./provision.ts` run over it, the event the reducer already
 * consumes out.
 *
 * **`Machine` is provided here, and it has to be.** A handler resolves exactly the services the
 * *spawner* granted its process, sealed (`apps/tuval/src/process/Processes.ts`) — and a spread
 * handler is not even arg-bound, so there is nowhere else to ask. Providing the layer at the
 * row-building site is therefore not a convenience: it is the only place that knows which `Runner`
 * this row was configured with, and it is what lets a test hand `fakeRunner()` in through the same
 * door a config hands the real machine.
 *
 * Exported for the reason `settle` and `openPlan` are: a suite that drives the whole chain — cell,
 * plan, machine, handler, reducer — catches a break that no half's own suite can see.
 */
export const workspaceHandlers = (
  settled: Settled,
): HostHandlers<WorkspaceEvent, WorkspaceEffect, never, never> => {
  const onMachine = <A>(
    program: Effect.Effect<A, never, Machine>,
  ): Effect.Effect<A, never, never> =>
    Effect.provide(program, machineLayer(settled.runner));

  return {
    "workspace.provision": (effect) =>
      onMachine(
        Effect.map(
          provision(effect.plan),
          (outcome): ReadonlyArray<WorkspaceEvent> => [
            outcome.ok
              ? {
                  type: "provisioned",
                  name: effect.plan.name,
                  port: outcome.port,
                }
              : {
                  type: "provisionFailed",
                  name: effect.plan.name,
                  step: outcome.step,
                  detail: outcome.detail,
                },
          ],
        ),
      ),

    "workspace.teardown": (effect) =>
      onMachine(
        Effect.map(
          teardown(effect.plan),
          (outcome): ReadonlyArray<WorkspaceEvent> => [
            outcome.ok
              ? { type: "closed", name: effect.plan.name }
              : {
                  type: "closeFailed",
                  name: effect.plan.name,
                  stage: outcome.stage,
                  detail: outcome.detail,
                },
          ],
        ),
      ),

    "workspace.reconcile": (effect) =>
      onMachine(
        Effect.map(
          reconcile(effect.records),
          (missing): ReadonlyArray<WorkspaceEvent> => [
            { type: "reconciled", missing },
          ],
        ),
      ),
  };
};

/**
 * The authored record, over one settled reading of the options. A function rather than a constant
 * because every default above was the config's to state — and it takes the `Settled` rather than
 * the raw options so that `workspace(…)` below reads the config **once**: the handlers and the
 * program have to be built over the same `Runner`, and a second `settle` of options that named
 * none would mint a second `nodeRunner()`.
 */
export const authoredWorkspace = (settled: Settled) => {
  const args = argsFor(settled.id);
  const { id, now } = settled;

  /** One refused `open`, written onto state. The four arms of the `open` cell agree here. */
  const refuse = (
    state: WorkspaceState,
    name: string,
    reason: RefusalReason,
  ): Answer<WorkspaceState> => [
    {
      ...state,
      refusals: refused(state.refusals, { name, reason, at: now() }),
    },
    [],
  ];

  /**
   * The body both `close` and `discard` share. The only difference between them is `force`, and it
   * is the whole difference: one asks git to remove the worktree and the other tells it to throw
   * uncommitted work away.
   */
  const closing = (
    state: WorkspaceState,
    name: string,
    force: boolean,
  ): Answer<WorkspaceState, WorkspaceEffect> => {
    const record = byName(state, name);
    if (record === undefined) return [state, []];
    if (state.pending !== null) return [state, []];
    if (record.status === "closing") return [state, []];
    const agent = record.agent;
    return [
      {
        ...state,
        seq: state.seq + 1,
        pending: {
          kind: "close",
          seq: state.seq + 1,
          name,
          force,
          stopping: agent,
        },
        workspaces: withRecord(state.workspaces, name, (one) => ({
          ...one,
          status: "closing",
          agent: null,
        })),
      },
      // **One effect, never two — and this is the bug that shape would be.** A removal under a live
      // session is a session writing into a directory being deleted, so the stop has to come first;
      // but `[stop(agent), teardownEffect(…)]` is not "first", it is "and only if the first one
      // worked". The actor runs a cell's effects serially and a failing handler short-circuits the
      // rest (`apps/tuval/src/host/actor.ts`), and `Processes.stop` fails `ProcessNotFound` on a
      // process already gone — so an agent that crashed a moment before its `stopped` landed would
      // cancel the removal, leave `pending` set, and refuse every later spell "busy" until restart.
      //
      // So the close is two steps: ask for the ending here, answer the teardown in the cell that
      // *receives* it. `stopped` is delivered by the child's own exit finalizer and is the single
      // producer of that event whether this cell asked or the agent simply died (phoenix#9229), so
      // the crash case and the orderly case arrive at the same place. With no agent up there is
      // nothing to wait for and the teardown is answered on the spot.
      agent === null
        ? [teardownEffect(closePlan(settled, record, force))]
        : [stop(agent)],
    ];
  };
  return {
    id,
    args,

    /**
     * Two in-ports, and they exist so the two spells have somewhere to land. A command may only
     * `send` (ADR 0372 as #8898 amended it), so an `open` is a payload on a port whose cell decides
     * what to do with it — never an effect the command asks for itself.
     */
    ports: {
      open: port.in(OpenRequest),
      close: port.in(CloseRequest),
      discard: port.in(DiscardRequest),
    },

    /**
     * `repo`, `repoName`, `root` and `base` are env rather than state — the config chose all four
     * and no cell moves any of them — and they are seeded here because a window is handed one
     * thing, this process's public state, and "which repository am I looking at" is the first line
     * a person opening this wants.
     */
    init: (): WorkspaceState => ({
      repo: settled.repo,
      repoName: settled.repoName,
      root: settled.root,
      base: settled.base,
      workspaces: [],
      pending: null,
      seq: 0,
      spawningFor: null,
      refusals: [],
      unattributed: [],
    }),
    update: {
      /**
       * Somebody asked for a workspace. Four refusals before anything is written down, and each one
       * is a thing that would otherwise be discovered by `git` at a point where the person has
       * stopped watching: a name a branch cannot be called, a name already held, a bound reached,
       * and a job already in flight.
       *
       * **Every one of them is written down.** A refusal that moved no state was a button that did
       * nothing and a spell that answered nothing — "the tile already says `3 open`" is an
       * inference, not an answer, and asks the person to work out which of four reasons applied.
       * The list is bounded at `REFUSAL_LIMIT` for the reason the workspace list is bounded at
       * `LIMIT`, so it is a window on the last few refusals rather than a log.
       */
      open: (
        state: WorkspaceState,
        event: { readonly payload: typeof OpenRequest.Type },
      ): Answer<WorkspaceState, WorkspaceEffect> => {
        const name = event.payload.name.trim();
        if (!NAME_PATTERN.test(name)) return refuse(state, name, "name");
        if (byName(state, name) !== undefined) {
          return refuse(state, name, "duplicate");
        }
        if (state.workspaces.filter(isLive).length >= LIMIT) {
          return refuse(state, name, "limit");
        }
        if (state.pending !== null) return refuse(state, name, "busy");
        const record = freshRecord(settled, name);
        return [
          {
            ...state,
            workspaces: recorded(state.workspaces, record),
            seq: state.seq + 1,
            pending: {
              kind: "open",
              seq: state.seq + 1,
              name,
              prompt: event.payload.brief ?? "",
            },
          },
          // The plan is derived here, where the record and the ports this program has already
          // handed out are both in hand — `takenPorts` reads the state *before* this one, which is
          // the same list either way because a fresh record holds no port yet.
          [provisionEffect(openPlan(settled, record, takenPorts(state)))],
        ];
      },

      /**
       * The worktree, the port, the `.env` and every setup command are done. The agent is asked for
       * here rather than at `open`, because an agent told to work in a directory that does not
       * exist yet is an agent that will make one.
       */
      provisioned: (
        state: WorkspaceState,
        event: Provisioned,
      ): Answer<WorkspaceState> => {
        // The brief is read off `pending` here and nowhere else: this is the last cell in which the
        // job that carried it is still on state.
        const queued = state.pending;
        const brief =
          queued !== null && queued.kind === "open" ? queued.prompt : "";
        return [
          {
            ...state,
            pending: null,
            spawningFor: settled.hasJob ? { name: event.name, brief } : null,
            workspaces: withRecord(state.workspaces, event.name, (record) => ({
              ...record,
              status: "open",
              port: event.port,
              detail: null,
            })),
          },
          startAgent(settled, args),
        ];
      },

      /**
       * A provision that stopped somewhere. The record is kept, not dropped: it holds the path of
       * the half-built worktree, which is the only way `:<id> close <name>` can take it away — and
       * it names the step, because "setup" and "worktree" are two very different mornings.
       */
      provisionFailed: (
        state: WorkspaceState,
        event: ProvisionFailed,
      ): Answer<WorkspaceState> => [
        {
          ...state,
          pending: null,
          workspaces: withRecord(state.workspaces, event.name, (record) => ({
            ...record,
            status: "failed",
            detail: `${event.step}: ${event.detail}`,
          })),
        },
        [],
      ],

      /** The agent is up. Record it, and tell it where it is — which is phoenix#9287's fallback. */
      spawned: (
        state: WorkspaceState,
        event: Spawned,
      ): Answer<WorkspaceState> => {
        const spawning = state.spawningFor;
        const record =
          spawning === null ? undefined : byName(state, spawning.name);
        if (record === undefined || spawning === null) {
          return [{ ...state, spawningFor: null }, []];
        }
        const startedAt = now();
        return [
          {
            ...state,
            spawningFor: null,
            workspaces: withRecord(state.workspaces, record.name, (one) => ({
              ...one,
              agent: event.process,
            })),
          },
          [
            send(
              { process: event.process, port: "prompt" },
              {
                text: preface(
                  record,
                  [settled.brief, spawning.brief]
                    .filter((part) => part.trim() !== "")
                    .join("\n\n"),
                ),
                key: `${id}-${record.name}-${startedAt}`,
                timestamp: startedAt,
              },
            ),
          ],
        ];
      },

      /**
       * The agent finished a turn. Its first line goes on the record, because that is the one thing
       * a tile can hold about what the agent is doing — and the session is left up, unlike cron's.
       * A workspace is a place to work, not one question: the session outliving its turn is the
       * point, and what ends it is `:<id> close <name>`.
       *
       * **Whose turn, though.** Tuval's `Reply` is `{type, payload}` and carries no process id
       * (`apps/tuval/src/authoring/effect.ts:179-182`), so with two agents up there is nothing in
       * this event that says which one answered. This cell therefore attributes a result **only
       * when exactly one agent is running**, where "the one running agent" is a fact rather than a
       * guess. With two up — or with none — the result goes to `unattributed`, off every workspace,
       * and the status line says how many are there.
       *
       * That is a consequence of the same gap as phoenix#9287, read from the other end: a spawn
       * cannot carry a cwd *to* a child, and a reply cannot carry a sender *from* one. When the
       * kernel names the sender this cell becomes a lookup and `unattributed` stops existing.
       */
      result: (
        state: WorkspaceState,
        event: Reply<"result", TurnResult>,
      ): Answer<WorkspaceState> => {
        const running = state.workspaces.filter((one) => one.agent !== null);
        const only = running.length === 1 ? running[0] : undefined;
        if (only === undefined) {
          return [
            {
              ...state,
              unattributed: unowned(state.unattributed, {
                text: firstLine(event.payload.text),
                at: now(),
              }),
            },
            [],
          ];
        }
        return [
          {
            ...state,
            workspaces: withRecord(state.workspaces, only.name, (one) => ({
              ...one,
              detail: firstLine(event.payload.text),
            })),
          },
          [],
        ];
      },

      /**
       * Somebody asked to put a workspace back, **without losing anything**. The agent is stopped
       * first, here, rather than left to the teardown commands: a removal under a live session is a
       * session writing into a directory that is being deleted. The removal itself asks git with no
       * `--force`, so a worktree holding uncommitted work refuses and says so.
       *
       * It is stopped *and waited for*, in two folds — see `closing` for why one list of two
       * effects is the bug rather than the shorthand.
       */
      close: (
        state: WorkspaceState,
        event: { readonly payload: typeof CloseRequest.Type },
      ): Answer<WorkspaceState, WorkspaceEffect> =>
        closing(state, event.payload.name.trim(), false),

      /**
       * The same thing, forcibly — `git worktree remove --force`, which throws uncommitted work
       * away. It is a spell of its own rather than a flag on `close` because the name is the
       * warning: `:<id> discard feature-x` reads as what it does, and `close --force` reads as a
       * close that tries harder. This is the **only** path in this package that passes `--force`.
       */
      discard: (
        state: WorkspaceState,
        event: { readonly payload: typeof DiscardRequest.Type },
      ): Answer<WorkspaceState, WorkspaceEffect> =>
        closing(state, event.payload.name.trim(), true),

      /** Teardown ran and the worktree is gone. So is the record — there is nothing left to name. */
      closed: (
        state: WorkspaceState,
        event: Closed,
      ): Answer<WorkspaceState> => [
        {
          ...state,
          pending: null,
          workspaces: without(state.workspaces, event.name),
        },
        [],
      ],

      /**
       * A close that did not finish, from either half — and in both halves the worktree is still
       * there and the record is kept, holding the reason, so the tile says why rather than a row
       * simply disappearing.
       *
       *  - `teardown`: a command the config wrote failed, so `./provision.ts` refused the removal.
       *  - `remove`: the commands ran and **git refused to remove the worktree** — which is what a
       *    dirty tree does when nothing passes `--force`. The uncommitted work is still on disk.
       *    `:<id> discard <name>` is the way through, and it is the only thing that forces.
       *
       * Either way the record comes back as `failed` — `failed` and not `open`, because the
       * teardown commands may have already run and calling a half-torn-down workspace open would
       * be the lie this whole cell exists to avoid. It keeps its path and its branch, so a second
       * `:<id> close <name>` retries the whole sequence once the tree is committed or the command
       * is fixed.
       */
      closeFailed: (
        state: WorkspaceState,
        event: CloseFailed,
      ): Answer<WorkspaceState> => [
        {
          ...state,
          pending: null,
          workspaces: withRecord(state.workspaces, event.name, (record) => ({
            ...record,
            status: "failed",
            detail: `${event.stage}: ${event.detail}`,
          })),
        },
        [],
      ],

      /**
       * A child ended — and this cell does two different things depending on whether a close was
       * waiting for that ending.
       *
       * **If it was, this is where the removal is asked for.** `closing` answered a `stop` and
       * nothing else, because the two could not go in one list (see there); this is the other half.
       * The ending is matched by process id rather than by "a close is pending", because with up to
       * `LIMIT` agents running a second workspace's session ending while this one is closing would
       * otherwise fire a teardown under a live agent — the exact thing the two-step exists to stop.
       * `stopped` is produced once per child end whether this program asked or the agent simply
       * died (phoenix#9229), so a crash and an orderly stop both arrive here.
       *
       * **Otherwise** whichever workspace held it loses its agent and nothing else moves, because a
       * workspace without a session is still a workspace: the worktree, the port and the database
       * are all still there and still this program's to dispose of.
       */
      stopped: (
        state: WorkspaceState,
        event: Stopped,
      ): Answer<WorkspaceState, WorkspaceEffect> => {
        const job = state.pending;
        if (
          job !== null &&
          job.kind === "close" &&
          job.stopping === event.process
        ) {
          const closing = byName(state, job.name);
          // The record is still there — `closed` is what removes it — unless something else took
          // it away, in which case there is no plan to build and nothing to remove.
          return closing === undefined
            ? [state, []]
            : [state, [teardownEffect(closePlan(settled, closing, job.force))]];
        }
        const record = state.workspaces.find(
          (one) => one.agent === event.process,
        );
        if (record === undefined) return [state, []];
        return [
          {
            ...state,
            workspaces: withRecord(state.workspaces, record.name, (one) => ({
              ...one,
              agent: null,
            })),
          },
          [],
        ];
      },

      /**
       * This program came back from a checkpoint. Three things are true of every restore and none
       * of them can be decided synchronously, which is why this cell queues a reconcile rather than
       * answering:
       *
       *  - **A held agent cannot answer.** Tuval's restore path spawns a checkpointed process with
       *    no `on` record and an `unwired` `ProcessPorts`, so a restored session's `result` reaches
       *    nobody however long this waits. It is cleared, and no `stop` is asked for — `stop` fails
       *    `ProcessNotFound` on a process the manifest did not bring back, and an authored effect's
       *    failure propagates out of the resume dispatch, which the kernel catches nowhere. So a
       *    blind reap would fail *boot* in exactly the case this cell exists for.
       *  - **A `pending` job died with the process.** Whatever it was is written down as failed;
       *    `provisioning` that nothing is provisioning is a tile that lies.
       *  - **A directory may not be there.** Somebody removed a worktree by hand between boots. The
       *    check is a disk read, so this cell answers a `workspace.reconcile` effect over the
       *    records it just settled and the handler reads the disk.
       *
       * The four env fields are re-seeded from the config on the way through, because the config is
       * the authority on them and a checkpoint never is: a `repo` moved in the config would
       * otherwise be pinned by the old checkpoint for ever.
       */
      restored: (
        state: WorkspaceState,
        _event: AuthoredEvent,
      ): Answer<WorkspaceState, WorkspaceEffect> => {
        const env = {
          repo: settled.repo,
          repoName: settled.repoName,
          root: settled.root,
          base: settled.base,
        };
        const interrupted = state.pending;
        const workspaces = state.workspaces.map((record) => ({
          ...record,
          agent: null,
          ...(record.name === interruptedName(interrupted) ||
          record.status === "provisioning" ||
          record.status === "closing"
            ? {
                status: "failed" as const,
                detail: "interrupted by restart",
              }
            : {}),
        }));
        return [
          {
            ...state,
            ...env,
            workspaces,
            spawningFor: null,
            seq: state.seq + 1,
            pending: { kind: "reconcile", seq: state.seq + 1 },
          },
          [
            reconcileEffect(
              workspaces.map((record) => ({
                name: record.name,
                path: record.path,
              })),
            ),
          ],
        ];
      },

      /**
       * The disk answered. A workspace whose directory is not there is recorded as `gone` — kept,
       * never deleted, because the record is now the only evidence that the directory was ever
       * supposed to exist, and it still names the branch somebody will want to look for.
       */
      reconciled: (
        state: WorkspaceState,
        event: Reconciled,
      ): Answer<WorkspaceState> => [
        {
          ...state,
          pending: null,
          workspaces: state.workspaces.map((record) =>
            event.missing.includes(record.name)
              ? { ...record, status: "gone" as const, agent: null }
              : record,
          ),
        },
        [],
      ],
    },

    /**
     * The one door a restarted workspace program has back into the world: a restored process starts
     * on its loaded state with no Cmds, so without this neither the interrupted job above nor the
     * disk check beside it is ever reconciled. Every restore is sent one `restored`, whatever the
     * checkpoint holds — the four env fields belong to the config and have to be re-read on every
     * boot, and an empty checkpoint simply takes the cheap half of that cell.
     */
    resume: (_state: WorkspaceState) => [{ type: "restored" as const }],
    commands: {
      /**
       * `:<id> open <name> [brief]` — provision one workspace and, if the config filled a `job`,
       * start an agent in it. A bare `send` and nothing else: a command may ask for no other effect
       * (ADR 0372 as #8898 amended it), so the call resolves to this program's own live process,
       * the payload lands on the `open` port, and the cell that owns it decides.
       */
      open: {
        args: OpenRequest,
        describe: "provision a workspace and start an agent in it",
        run: (request: typeof OpenRequest.Type) => send("open", request),
      },

      /**
       * `:<id> close <name>` — stop the agent, run teardown, remove the worktree, free the record.
       * Nothing here throws work away: git is asked without `--force`, so a worktree with
       * uncommitted changes in it refuses and the record survives holding git's own reason.
       */
      close: {
        args: CloseRequest,
        describe: "tear a workspace down and remove its worktree",
        run: (request: typeof CloseRequest.Type) => send("close", request),
      },

      /**
       * `:<id> discard <name>` — the same close, forced. The one path that passes `--force`, and
       * so the one path that can throw uncommitted work away. Named for what it costs.
       */
      discard: {
        args: DiscardRequest,
        describe:
          "tear a workspace down and force-remove its worktree — uncommitted work is lost",
        run: (request: typeof DiscardRequest.Type) => send("discard", request),
      },
    },
    title: (_state: WorkspaceState): string => `${id} · ${settled.repoName}`,

    /**
     * The tile's second line, drawn by `./state.ts` so the window draws the same sentence from the
     * same function rather than a second statement of it.
     */
    status: statusLine,
  };
};

/**
 * The authored record over raw options — the door every test and every caller but `workspace(…)`
 * below comes through.
 */
export const workspaceProgram = (options: WorkspaceFill) =>
  authoredWorkspace(settle(options));

const interruptedName = (pending: WorkspaceState["pending"]): string | null =>
  pending === null || pending.kind === "reconcile" ? null : pending.name;

const firstLine = (text: string): string => (text.split("\n")[0] ?? "").trim();

/**
 * The row, as a config writes it: `workspace({repo, setup, teardown, job})`.
 *
 * The `job` goes onto the row's `fill` — the config call's half of `args` — so the `spawn` in
 * `provisioned` resolves the arg's service key back to the program this row was built with, rather
 * than asking the registry for `tuval/arg/workspace/job` and being told no such program exists. A
 * `job` that does not fit `jobShape` is refused here, at definition, by `defineProgram` itself.
 *
 * With no `job` the row declares no args at all: `defineProgram` fills every declared arg, and a
 * declared-but-unfilled one is a crash at config load rather than a program that simply provisions.
 *
 * **And the spread is the seam.** `defineProgram`'s sixth type argument says which effects this
 * program's cells may answer; the handler for each of them comes from `{...row.handlers, …}` here
 * and from nowhere else, because the compiler returns before any spread exists and so refuses
 * nothing (kamp-us/phoenix#9295). An effect with no handler is skipped silently by the actor — the
 * one unenforced joint in this chain, and the reason the three keys are written out once, in
 * `workspaceHandlers`, rather than inline.
 */
export const workspace = (fill: WorkspaceFill): AnyProgram => {
  const settled = settle(fill);
  const authored = authoredWorkspace(settled);
  const job = fill.job;
  const row =
    job === undefined
      ? defineProgram<
          WorkspaceState,
          (typeof authored)["ports"],
          (typeof authored)["update"],
          WorkspaceCommands,
          unknown,
          WorkspaceEffect
        >({
          id: authored.id,
          ports: authored.ports,
          init: authored.init,
          update: authored.update,
          resume: authored.resume,
          commands: authored.commands,
          title: authored.title,
          status: authored.status,
          label: `${authored.id} (${basename(fill.repo)})`,
        })
      : defineProgram<
          WorkspaceState,
          (typeof authored)["ports"],
          (typeof authored)["update"],
          WorkspaceCommands,
          unknown,
          WorkspaceEffect
        >({
          ...authored,
          fill: { job },
          label: `${authored.id} (${job.id})`,
        });
  return {
    ...row,

    /** The three the kernel does not write, over the `Runner` this row was configured with. */
    handlers: { ...row.handlers, ...workspaceHandlers(settled) },

    /**
     * The window, named rather than declared. `defineProgram` compiles an authored `window` field
     * into a `host-native` reference and seats the renderer in a map *inside the kernel process* —
     * and the page is a browser tab, so nothing over there can reach that map (kamp-us/phoenix
     * #8811, open). A `kind: "module"` reference is the route that does cross: the page loads the
     * specifier itself at boot (ADR 0359).
     */
    renderer: WORKSPACE_WINDOW_REF,
  };
};
