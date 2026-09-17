# @kampus/tuval-workspace

Isolation for [Tuval](https://github.com/kamp-us/phoenix/tree/main/apps/tuval): give it a name and
it provisions a disposable set — a git worktree cut from a base ref, a TCP port nothing else holds,
an `.env` written from your template with that port in it, and whatever setup command builds the
rest — starts an agent session for it, shows it on the board, and puts all of it back on close.

## The problem

Two agents on one repository collide, and they collide four times:

| They share | What happens |
|---|---|
| the worktree | one rebases under the other, mid-edit |
| the dev port | the second server will not start |
| the `.env` | a variable one agent changes is changed for both |
| the local database | one agent's migration is the other's broken fixture |

Conductor, Claude Squad and Cursor Mission Control each hand you the worktree and stop there. The
port, the env file and the database are left to you — which is to say, left to collide. This package
is the argument that all four are one thing: **declared inputs, resolved together per workspace,
disposed of together.** nix-shell's idea, pointed at agents rather than at builds.

## Usage

```ts
// ~/.tuval/tuval.config.ts
import {workspace} from "@kampus/tuval-workspace";
import {ClientId, claudeSession, type TuvalConfigInput, WorkspaceId} from "@kampus/tuval/sessions";

const REPO = "/code/my-app";
const scope = {workspace: WorkspaceId.make("default"), client: ClientId.make("tuval-desk")};

export default {
  version: 1,
  programs: [
    workspace({
      repo: REPO,
      base: "origin/main",
      port: {from: 5170, to: 5199},
      env: {template: ".env.example", portKey: "PORT"},
      setup: ["createdb app_$NAME", "pnpm install", "pnpm db:migrate"],
      teardown: ["dropdb --if-exists app_$NAME"],
      job: claudeSession({cwd: REPO, scope}),
    }),
  ],
  graph: {nodes: [{id: "workspace", program: "workspace", on: []}]},
} satisfies TuvalConfigInput;
```

Then, on the desk:

```
:workspace open feature-x
:workspace close feature-x      # never loses work — a dirty worktree refuses
:workspace discard feature-x    # the one spell that forces, and loses uncommitted work
```

`open` cuts `.workspaces/feature-x` on branch `can/feature-x` from `origin/main`, probes 5170
upwards for a free port, copies `.env.example` into the worktree with `PORT=` rewritten, runs the
three setup commands inside it, and starts the agent. `close` stops the agent, runs `dropdb`,
removes the worktree, and frees the record.

| Field | What it is |
|---|---|
| `repo` | The repository worktrees are cut from, absolute. The one field with no default. |
| `id` | What this program is called: its program id, its graph node id, and the first word of both spells (`:lane open`). Defaults to `"workspace"` — name it when a config holds more than one. |
| `base` | The ref a new workspace's branch starts at. `origin/main`. |
| `root` | Where worktrees go. A relative path is resolved against `repo`. `.workspaces`. |
| `branchPrefix` | What a workspace's branch is called: this, then the name. `can/`. |
| `port` | `{from, to}`, probed upwards for the first port nothing holds. `{from: 5170, to: 5199}`. |
| `env` | `{template, portKey, vars?, file?}`, or `false` for a repository with no env file to copy. Defaults to `{template: ".env.example", portKey: "PORT"}`. |
| `setup` | Command lines run inside a fresh worktree, in order, after the `.env` is written. |
| `teardown` | Command lines run inside a workspace before it is removed, in order. |
| `brief` | Extra sentences appended to the where-you-are preface every agent is sent. |
| `job` | The program to start inside a workspace — any row whose ports fit `jobShape` (`prompt` in, `result` out). Optional: a workspace program with no `job` only provisions. |
| `now` | Optional clock, so a test states the time instead of reading one. |
| `runner` | The machine. Injected so a test never touches git, a port or the disk. |

### Substitution variables

Four names are resolved by this package **before the shell sees the command**, in every `setup`
line, every `teardown` line, and every value under `env.vars`:

| | |
|---|---|
| `$NAME` | what you called the workspace — `feature-x` |
| `$PORT` | the port the probe found — `5174` |
| `$WORKTREE` | the worktree, absolute — `/repo/.workspaces/feature-x` |
| `$BRANCH` | the branch it is on — `can/feature-x` |

`${NAME}` works too. Anything this package does not own — `$HOME`, `$PATH`, `$NAMESPACE`, `$$` — is
left for the shell untouched, so `PATH=$PATH:./bin pnpm build` in a `setup` line means what it says.

> **This was `$PATH` before, and the rename is a fix.** Substitution runs over the raw command line
> *before* the shell sees it, so `$PATH` meaning the worktree silently turned `PATH=$PATH:./bin`
> into a corrupted search path with no `$PATH` ever reaching the shell. `$WORKTREE` collides with
> nothing a shell already owns, which is why the old `$$` escape is gone too — there is nothing
> left to escape.

### The order, which is the contract

**worktree → port → env → setup**, always, and a test asserts it as a list rather than as prose. Each
step needs the one before it: the `.env` is written *into* the worktree, the port goes *into* the
`.env`, and `setup` runs *in* the worktree with `$PORT` already resolved.

A provision that fails stops at that step, names it, and **keeps the half-built worktree** — the
record goes to `failed` holding its path, because the path is how `:workspace close <name>` takes it
away and the output is the only evidence of what went wrong.

Teardown is the same rule read backwards: a teardown command that fails **refuses the removal**. A
`dropdb` that did not work means the scratch database is still there, and removing the worktree on
top of that deletes the only thing that knows which database it was. Fix the command, ask again.

### Close never loses work; `discard` says that it does

`:workspace close <name>` stops the agent inside the workspace, waits for that session's ending,
then runs `git worktree remove <path>` — **without `--force`**. A worktree
holding uncommitted or untracked work makes git refuse, and that refusal comes back exactly like a
failed teardown command's: the record stays, as `failed`, holding git's own sentence, so the tile
says why rather than a row quietly disappearing. The window's **Close** button sends that same
close and has no forcing variant.

There is one way to throw work away, and it is a spell of its own:

```
:workspace discard feature-x
```

`discard` is the only path in this package that passes `--force`. It is a separate command rather
than a flag on `close` because the name is the warning — `close --force` reads as a close that tries
harder, and `discard` reads as what it does. The window offers it as a separate, separately
labelled **Discard (loses work)** control, pushed away from Close.

### What a failure detail may carry

A failed command's output goes onto the record, and the record is checkpointed to disk. So the
output is redacted and bounded first:

- a URL with credentials — `https://user:pw@host` becomes `https://***:***@host`;
- a `KEY=value` whose key contains `SECRET`, `TOKEN` or `PASSWORD` in any case — the value becomes
  `***`, the key is kept, because which variable it was is the useful half;
- then the whole thing is cut to 500 characters with `… (truncated)` on the end.

Neither rule is a promise that the output is now secret-free — a command that prints a bare token
still prints a bare token. They cover the two shapes a secret takes in build output.

## What a refusal looks like, and the one thing it never is

Silence. Four things make `:workspace open <name>` refuse — a name a branch and a directory cannot
both be called, a name already held, the bound on live workspaces, and a job already in flight — and
every one of them is written down on state, spelled out in the window and named in the tile's second
line (`… · refused bugfix: busy`). The list is bounded at five, so it is a window on the last few
refusals rather than a log. A refusal that moved no state was a button that did nothing, and
"nothing happened" is the one answer a person cannot act on.

## Two agents, and the reply that carries no sender

A turn result is attributed to a workspace **only when exactly one agent is running.** Tuval's
`Reply` is `{type, payload}` and carries no process id
(`apps/tuval/src/authoring/effect.ts:179-182`), so with two agents up there is nothing in the event
that says which one answered — and the honest answer to that is not a guess. With more than one
running (or with none), the result goes to an `unattributed` list that belongs to no workspace, the
status line says how many are there, and the window shows them with the reason.

This is the sibling of the cwd gap below, read from the other end: a spawn cannot carry a cwd *to*
a child, and a reply cannot carry a sender *from* one. Both are
[kamp-us/phoenix#9287](https://github.com/kamp-us/phoenix/issues/9287)'s to answer. When the kernel
names the sender, this list stops existing.

## The cwd decision — read this before you expect too much

**An agent session cannot be started in a directory this program chose at runtime.** That is a
kernel gap, not a shortcut taken here, and it is filed as
[kamp-us/phoenix#9287](https://github.com/kamp-us/phoenix/issues/9287).

What the kernel says, read at the current checkout:

- `spawn(program, {on})` carries a program id and an out-port routing table and nothing else —
  `apps/tuval/src/authoring/effect.ts:111-118`. `SpawnEffect` is `{type, program, on}`; there is no
  slot for arguments.
- `cwd` is baked onto the registry row at config time: `claudeSession({cwd})` →
  `src/claude/program.ts:115` → `src/ai-agent/core/machine.ts:187` →
  `src/claude/agent/options.ts:135`, which is the SDK option the CLI launches under. It never
  changes live (`src/claude/program.ts:134`).
- `claude-session`'s id is a constant (`src/claude/renderer-ref.ts:12`) and a duplicate id fails the
  registry layer, so "one row per cwd" is not available either. Rows are boot-time only.
- `PromptPayloadSchema` is `{text, key, timestamp}` — no `cwd` field, so the prompt cannot carry one.
- The one per-spawn cwd mechanism, `SessionOpening` (`src/ai-agent/opening.ts:17-25`), is produced
  by the shell picker and read by the `aiAgent.boot` handler; nothing an authored program can reach
  produces it, and its own docblock rules out growing `Processes.spawn` into a program-arguments
  system.

**So v1 ships the fallback, named as one.** The session runs on whatever cwd your config gave
`claudeSession`, and the workspace reaches it **in words** — the prompt it is sent is prefixed with:

> You are working in `/repo/.workspaces/feature-x` on branch `can/feature-x`; dev port 5174. Start
> by changing into that directory — it is a git worktree of its own and it is not where this session
> started.

That is a sentence, not an invariant. An agent that ignores it is refused by nothing, and a relative
path it opens before reading the preface lands in the wrong tree. Everything *below* the session is
real and unaffected: the worktree exists, the port is held, the `.env` is written, the scratch
database is made and dropped. When #9287 is answered, the preface stops being load-bearing and the
only change here is one `spawn` call.

A workspace program with no `job` at all is a first-class shape, and is what to use if the words
bother you: `:workspace open feature-x` provisions everything and hands you a path to open a session
in yourself.

## Personas

Five complete configs live in [`examples/`](./examples), each type-checked by this package's
`typecheck` and driven by `src/examples.unit.test.ts` against the fake runner — so what a header
claims is what the config actually issues, and no git, docker, nix or psql ever runs.

| | For | Isolation declared |
|---|---|---|
| [`solo-laptop`](./examples/solo-laptop.tuval.config.ts) | one person, two agents, one laptop | worktree + free port + `.env` with `PORT` rewritten |
| [`web-app-postgres`](./examples/web-app-postgres.tuval.config.ts) | a web app on a local Postgres | the above, plus a `DATABASE_URL` per workspace and a scratch database created and dropped |
| [`docker-compose`](./examples/docker-compose.tuval.config.ts) | a stack that comes up as a compose project | a compose project named for the workspace, `up -d --wait` / `down -v`, published port from `.env` |
| [`nix`](./examples/nix.tuval.config.ts) | a flake-based repository | worktree + port, **no env step** (`env: false`), dev shell warmed in setup, `nix develop -c` in the brief |
| [`fabrika-lane`](./examples/fabrika-lane.tuval.config.ts) | two fabrika builders on one machine | a workspace per lane: name is the issue number, branch `build/<issue>`, frozen install |

## The board tile and the window

The tile reads `workspace · my-app` with `2 open · feature-x :5174 running` under it — or
`1 open · provisioning bugfix` while something is in flight. The window is the list the tile cannot
be:

```
my-app
2 open · feature-x :5174 running · refused bugfix-2: duplicate
origin/main → /code/my-app/.workspaces

[ feature-x ]  [ Open ]   same as :workspace open <name>

Refused
bugfix-2 — a workspace of that name is already held

feature-x  :5174  open     running   [Close]      [Discard (loses work)]
  can/feature-x · /code/my-app/.workspaces/feature-x
  rewrote three call sites; tests green

bugfix     :5175  failed   failed    [Close]      [Discard (loses work)]
  can/bugfix · /code/my-app/.workspaces/bugfix
  remove: fatal: '…/bugfix' contains modified or untracked files, use --force to delete it
```

Open, Close and Discard are the spells without the palette: `WindowHost` offers `dispatch` and no
spell call, and all three spells are themselves bare `send`s, so the buttons dispatch the same
arrivals into the same cells. **Close never forces**, from the button or from the spell; Discard is
the separate, separately labelled control that does, and it is pushed away from Close because
neighbouring buttons doing very different things is how a misclick becomes a lost afternoon.
Everything is disabled while a provision or a close is in flight — one at a time, because two
concurrent `git worktree add` on one repository is not a thing to do and two concurrent port probes
would hand out the same port twice.

**How the window gets to the browser.** The row carries
`renderer: {kind: "module", ref: "@kampus/tuval-workspace/window"}` and the desk's page imports
that specifier itself at boot
([ADR 0359](https://github.com/kamp-us/phoenix/blob/main/.decisions/0359-tuval-window-renderer-is-a-module-specifier.md)).
The other route — an authored `window` field on `defineProgram` — does not work for a package: it
seats the renderer in a map inside the *kernel* process, which the browser tab cannot reach (phoenix
[#8811](https://github.com/kamp-us/phoenix/issues/8811), open).

**What that asks of your config, and it is not nothing.** The page resolves the specifier from the
config module that declared the row, not from the app (phoenix #8262). So
`@kampus/tuval-workspace` has to resolve from beside your `tuval.config.ts` — `pnpm add` it in
`~/.tuval/`, or link it there — and this package has to have been **built**, because `./window`
points at `dist/window.js`. A specifier that resolves from neither there nor the page root refuses
the page at boot, naming the specifier and your config. The kernel is unaffected either way — the
spells still work — but the desk has no page until it resolves.

## Restart, and what a missing directory means

A restart cuts whatever was in flight in half, so `resume` reconciles three things at once:

- **A held agent cannot answer.** Tuval's restore path spawns a checkpointed process with no `on`
  record and an `unwired` `ProcessPorts`, so a restored session's `result` reaches nobody. It is
  cleared — and **no `stop` is asked for**, because `stop` fails `ProcessNotFound` on a process the
  manifest did not bring back and an authored effect's failure propagates out of the resume dispatch
  uncaught. A blind reap would fail *boot* in exactly the case the cell exists for.
- **An interrupted provision or close** is written down as `failed`; `provisioning` that nothing is
  provisioning is a tile that lies.
- **A directory somebody removed by hand** is recorded as **`gone`, never deleted.** The record is
  then the only evidence the directory was supposed to be there, and it still names the branch
  somebody will want to look for.

The four env fields (`repo`, `repoName`, `root`, `base`) are re-seeded from the config on every
restore, because the config is the authority on them and a checkpoint never is.

## How it relates to Tuval

This is a Tuval **program**, built on `defineProgram` out of `@kampus/tuval/authoring`. Everything
around the program is the kernel's: the board tile is what the kernel renders from the `title` and
`status` lines this program publishes; checkpoint and restore are the kernel's; the two spells are
`commands` entries the kernel compiles and registers under the program id, so they are addressable
from the command line, a key binding, or an agent.

It names no session. The job arrives as a shaped arg — typed by its ports alone — so this package
imports no agent implementation, and which program fills it is your config's call.

Provisioning is an **effect this program named and a handler it wrote**, for the reason any real
work is: an `update` cell is pure and synchronous, and `git worktree add` is neither. A cell answers
a `workspace.provision` carrying the whole plan, the actor hands that value to the handler the row
was spread with, and the answer arrives as an ordinary dispatched event.

### The provisioning itself is an Effect program

`src/provision.ts` is `Effect.gen` over the four steps, and the order *is* the statements: a step
that fails short-circuits the rest by construction. Four `Schema.TaggedError` classes are the
four ways it stops — `WorktreeFailed`, `NoFreePort`, `EnvTemplateMissing`, `SetupFailed` — so a
failure **names its step by type**, through an exhaustive map off the `_tag`, and there is no
`step: string` anybody could set wrong. Close has two of its own: `TeardownCommandFailed` and
`RemoveRefused`.

The worktree is taken with `Effect.acquireRelease`, and its release **records rather than deletes**:
on a scope that ended in failure it writes the half-built tree's path down as `kept` on the outcome.
That is the documented rule above, as a value a test asserts on rather than a paragraph.

The machine is a service. `Machine` (`Context.Service`, shape `Runner`) is what every git call,
socket bind and file read goes through; `MachineLive` is the real one and `machineLayer(runner)`
hands in any other — which is how this package's suite, and your own config's, run the real program
against the recording fake.

### Provisioning runs in an effect handler, which is where it belongs

Demlik's own discipline is explicit: *"Sub handlers OBSERVE; they dispatch Msgs. Side effects live
ONLY in `interpret`"* (`.patterns/tea/tea-discipline.md`, invariant 3). This package used to run
`git worktree add` from a dep-keyed Sub and said so, as a disclosed violation held open for want of
a seam — the authoring layer's intended home for a program's own side effect is a **custom effect
handler on the spread row**: *"Effect appears only when a user writes their own effect handler; the
raw row is reachable by spread"* (kamp-us/phoenix#8716, R12.1).

kamp-us/phoenix#9295 shipped that seam, and this package is on it. The Sub, the `Effect.runFork`
bridge and the `Fiber.interrupt` disposer are gone.

**Two halves, both written here.** The type half is `defineProgram`'s sixth type argument, which
widens `Answer<State, X>` to the effects this program's cells may answer:

```ts
export interface Provision {
	readonly type: "workspace.provision";
	readonly plan: ProvisionPlan;
}

export type WorkspaceEffect = Provision | Teardown | Reconcile;
```

The runtime half is the spread, in `workspace(…)`:

```ts
return {
	...row,
	handlers: {...row.handlers, ...workspaceHandlers(settled)},
	renderer: WORKSPACE_WINDOW_REF,
};
```

A handler is `(effect) => Effect<ReadonlyArray<Msg>>` — its follow-ups as a *list*, one entry or
none, never a bare Msg — and the actor dispatches every entry back into this same process's inbox,
where the `update` cell of that name takes it. So `open` answers a `workspace.provision`, the
handler runs `src/provision.ts` over its plan, and `provisioned` or `provisionFailed` lands on the
reducer exactly as before. The reducer never moved: it was pure TEA before and it is pure TEA now.

**Three effects, not two.** `workspace.provision`, `workspace.teardown` and `workspace.reconcile`.
The third is a disk read rather than a write, but it belongs on this side of the seam with the
other two: it happens *once, in answer to an event* (`restored`), rather than standing open
observing anything, which is the thing a Sub is for.

**Each effect carries a whole plan, resolved.** A handler is handed its effect and nothing else —
no state, no config, no lookup — so the cell that answers an effect is the cell that derives it:
`openPlan`/`closePlan` run *there*, while the record and the ports already handed out are still in
hand. That closes by construction the one race the Sub had: there is no window between "queued" and
"run" in which the record could go away, so the branch that used to answer nothing for a vanished
record does not exist any more.

**`Machine` is provided inside the handler, and it has to be.** A handler resolves exactly the
services the *spawner* granted its process, sealed (`apps/tuval/src/process/Processes.ts`), and a
handler added by spread is not even arg-bound — so there is nowhere else to ask. Providing
`machineLayer(settled.runner)` at the row-building site is not a convenience: it is the only place
that knows which `Runner` this row was configured with, and it is what lets a test hand
`fakeRunner()` in through the same door a config hands the real machine.

**The one unenforced joint.** `defineProgram` returns before any spread exists, so it cannot refuse
an effect the row has no handler for; the actor skips such an effect silently and the process keeps
running — a workspace that is never provisioned and no error anywhere. That is why the three keys
are written out once, in `workspaceHandlers`, rather than inline at the two call sites, and why
`src/workspace.unit.test.ts` asserts the compiled row's `handlers` holds all three plus the six the
kernel wrote. It is the only place that check can be made.

**A close is two effects in two folds, and that is not an accident.** A removal under a live session
is a session writing into a directory being deleted, so the `stop` has to come first — but
`[stop(agent), teardownEffect(…)]` is not "first", it is "and only if the first one worked". The
actor runs a cell's effects serially and a failing handler short-circuits the rest
(`apps/tuval/src/host/actor.ts`), and `Processes.stop` fails `ProcessNotFound` on a process already
gone. So an agent that crashed a moment before its `stopped` landed would cancel its own workspace's
removal, leave `pending` set, and get every later spell refused "busy" until restart.

The `close` cell therefore answers *only* the `stop` when an agent is up, and the `stopped` cell —
which receives the ending, matched by process id so a second workspace's session ending cannot fire
this one's teardown — answers the removal. `stopped` is produced once per child end whether this
program asked for it or the agent simply died (kamp-us/phoenix#9229), so the crash and the orderly
stop arrive at the same place. With no agent up there is nothing to wait for and the removal is
asked for on the spot. `pending.stopping` is the process being waited on, and it is why a plain
"a close is pending" flag would not do.

**`pending` survives, as a mutex and nothing else.** It is what makes the `open` cell refuse a
second job, what the status line reads to say what is happening, where the `provisioned` cell reads
back the brief its `open` carried, and what `restored` writes down as failed. Nothing reads it to
decide what to *do* any more.

## Install, and the honest dependency

```bash
pnpm add @kampus/tuval-workspace
```

There are no runtime dependencies at all — `node:child_process`, `node:net`, `node:fs/promises` and
`node:path` are the whole of what provisioning needs. Everything else is a peer.

`@kampus/tuval` is **private and not published to npm**. This package now lives in the same
workspace as Tuval does, so the dependency is a plain workspace one —
`"@kampus/tuval": "workspace:*"` — and pnpm resolves it to `apps/tuval` in this repo with no path
link and no second checkout anywhere. It becomes a real version range the day Tuval ships to a
registry; nothing in the source changes with it, because the source already imports only through
the published doors (#8943, #9250):

- `@kampus/tuval/authoring` — `defineProgram`, `programArgs`, `port`, `Program.shape`, the effect
  constructors (`send`/`spawn`/`stop`), `testProgram`, `ProcessId`, `TITLE_PORT`/`STATUS_PORT`, and
  the types around them (`ArgRefs`, `Spawnable`, `PortSchema`)
- `@kampus/tuval/window` — `windowRenderer` and `WindowHost`, the browser-safe half. `src/window.tsx`
  is the only file that touches it, and `src/state.ts` is the kernel-free leaf both halves share so
  a browser never has a path to `src/workspace.ts`
- `@kampus/tuval/ai-agent/ports` — `PromptPayloadSchema`, `TurnResultSchema`: the agent *interface*,
  which pulls in no agent
- `@kampus/tuval/sessions` — `claudeSession`/`codexSession`, the branded `ClientId`/`WorkspaceId`,
  and `TuvalConfigInput`, which only a config needs

Nothing reaches `@kampus/tuval/src/...`; the exports map would refuse it anyway.

## Settings this package borrows from Tuval

Two settings here are not this package's taste. They are restatements of `apps/tuval`'s, and they
exist because `@kampus/tuval` is consumed as **raw TypeScript source**: its `exports` map points at
`src/*.ts` and it ships no `.d.ts`. Both go away the day Tuval publishes built declarations.

**`tsconfig.json`: `lib: ["ES2023", "DOM", "DOM.Iterable"]` and `exactOptionalPropertyTypes: false`.**
Tuval's whole reachable source tree enters this program and is checked under *these* options —
`skipLibCheck` covers declaration files and does nothing for source. These two lines are
`apps/tuval/tsconfig.json`'s, restated, and a consumer that picked its own would be told about
`findLast`, `Element` and the MCP SDK's optional props in code it does not own.

**`vitest.config.ts`: `resolve.dedupe: ["effect", "@demlik/tea"]`.** One workspace and one
root `catalog:` pin already give the suite a single `effect`, so this line is belt and braces here
rather than the load-bearing fix it was when Tuval was reached by path at an outside checkout — two
instances meant a `Schema` built by one was a stranger to a decoder from the other, and a spell's
args decoded to `Symbol()` instead of `{}`. It stays because the day this package is consumed from
npm beside an unhoisted Tuval, that failure comes back, and it costs nothing now.

## Trust model — read this

Tuval runs local program code with **full trust and no sandbox, ever**. This package is one step
past that: your `setup` and `teardown` are command *lines*, run through a shell with your user's
authority, in a directory this program created. `createdb`, `docker compose down -v` and
`:workspace discard`'s `git worktree remove --force` all do exactly what they say. Read them as you
would read a crontab,
because that is what they are — and remember that the agent that then works in that directory is an
unattended session with whatever access you gave it.

## Testing

```bash
pnpm test        # 156 cases
pnpm typecheck
pnpm build
```

No kernel, no desk, no git, no port bind, no disk. The whole machine is behind one injected `Runner`
(`src/runner.ts`), and every test runs against the recording fake beside it (`src/fake-runner.ts`) —
which is exported, so your own config's test can use the same one.
