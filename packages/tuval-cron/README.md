# @kampus/tuval-cron

A scheduler for [Tuval](https://github.com/kamp-us/phoenix/tree/main/apps/tuval): it wakes on a
timer, starts a *job* program, says on its board tile how that went, and announces the finished turn
on a `brief` out-port so something downstream can have it.

## Usage

```ts
// ~/.tuval/tuval.config.ts
import {cron} from "@kampus/tuval-cron";
import {ClientId, claudeSession, type TuvalConfigInput, WorkspaceId} from "@kampus/tuval/sessions";

const scope = {workspace: WorkspaceId.make("default"), client: ClientId.make("tuval-desk")};

export default {
  version: 1,
  programs: [
    cron({
      everyMs: 10 * 60 * 1000,
      prompt: "Using the gh CLI, summarize what changed here in the last 24 hours. Five lines max.",
      job: claudeSession({cwd: "/path/to/repo", scope}),
    }),
  ],
  graph: {nodes: [{id: "cron", program: "cron", on: []}]},
} satisfies TuvalConfigInput;
```

| Field | What it is |
|---|---|
| `id` | What this cron is called: its program id, its graph node id, and its spell (`:morning-brief run`). Defaults to `"cron"` — name it when a config holds more than one. |
| `everyMs` | How often to wake, in milliseconds. `null` wakes only when told to. Mutually exclusive with `schedule`. |
| `schedule` | A 5-field cron expression — `"0 7 * * *"` is 07:00 every day, local time. `*`, numbers, lists (`1,15`), ranges (`1-5`) and steps (`*/10`) all work; a leading seconds field is accepted but never required. Mutually exclusive with `everyMs`. |
| `prompt` | What the job is asked, every time cron wakes. |
| `job` | The program to start — any row whose ports fit `jobShape` (`prompt` in, `result` out). A `claudeSession`/`codexSession` row fits on its own. |
| `now` | Optional clock, so a test states the time instead of reading one. |

```ts
cron({
  schedule: "0 9 * * 1-5", // 09:00 on weekdays, local time
  prompt: "Any red CI on main? One line.",
  job: claudeSession({cwd: "/path/to/repo", scope}),
});
```

### More than one cron

One config, a morning brief and an evening summary — each named, because a program id is also a
graph node id and the first word of a spell, and two rows under `"cron"` collide on all three:

```ts
export const morningBrief = cron({
  id: "morning-brief",
  schedule: "0 7 * * *",
  prompt: "What changed on this repo overnight? Five lines max.",
  job: claudeSession({cwd: "/path/to/repo", scope}),
});

export const eveningSummary = cron({
  id: "evening-summary",
  schedule: "0 18 * * *",
  prompt: "What is still open? Three lines max.",
  job: claudeSession({cwd: "/path/to/repo", scope}),
});

export default {
  version: 1,
  programs: [morningBrief, eveningSummary],
  graph: {
    nodes: [
      {id: "morning-brief", program: "morning-brief", on: []},
      {id: "evening-summary", program: "evening-summary", on: []},
    ],
  },
} satisfies TuvalConfigInput;
```

Two tiles (`morning-brief · daily 07:00`, `evening-summary · daily 18:00`), two spells
(`:morning-brief run`, `:evening-summary run`), and each row's `job` is its own — the fill is keyed
under the cron's id, so neither reads the other's. An `id` with a space in it, or an empty one, is
refused at `cron(...)`: `:morning brief run` addresses nothing.

There are three ways to be woken and no fourth, and the options are a union so the checker says so:
`{everyMs: 600000}` ticks on a fixed interval, `{schedule: "0 7 * * *"}` fires on a cron expression
read in local time, and `{everyMs: null}` never wakes itself at all. Passing `everyMs` *and*
`schedule` is a type error and a throw at `cron(...)`, and so is a cron expression that does not
parse — a bad schedule is refused where you wrote it, never at the first tick hours later.

A schedule arms one timer at the next fire, ticks, and recomputes from the clock — so a slow tick
never accumulates drift, and a laptop that slept past 07:00 and woke at 09:00 fires **once** on
waking and then aims at 07:00 tomorrow, rather than replaying every mark it missed.

Put it in `graph` and it ticks from boot; leave it out and it is there for `:cron run`.

**`:cron run`** (or `:<id> run` for a named cron) — one job, now, on the cron the desk booted. Same run a tick is, prompt and all;
dropped if one is already running, because cron reports one run at a time and the tile already
says `running since`.

The tile reads `<id> · every 600s` — or `<id> · daily 07:00` for a schedule simple enough to say in
words, and the expression itself (`cron · 0 9 * * 1-5`, `morning-brief · 0 9 * * 1-5`) for one that is not — with `last run 07:00 · ok` under it — or `running since
07:00:12` while a job is up. History is bounded at ten runs.

## What leaves cron

A cron has one in-port and one out-port of its own, beside the two the kernel draws the tile from.

| Port | Way | Payload | When |
|---|---|---|---|
| `run` | in | `{}` | `:<id> run`, or the window's **Run now** — one job, now |
| `brief` | out | `TurnResult` (`@kampus/tuval/ai-agent/ports`) | every time the job answers, ok or failed |

`brief` is the finished turn itself — the whole `TurnResult`, not the one line the tile keeps — so
whatever you wire it to gets the brief, and reads `payload.ok` to decide what a failed turn is
worth. It is named `brief` and not `result` because `result` already means two other things here:
the cell the job's reply lands on, and the out-port on the *job's* side of `jobShape`.

**Only a real turn leaves through it.** A job that ends before it answers, and a run a restart cut
in half, are both written down as failed runs and both show on the tile — and neither emits, because
there is no `TurnResult` behind either and a fabricated empty turn would be cron putting words in a
job's mouth. If you need to know that a run *vanished*, watch the tile's `status`; `brief` does not
carry it.

Wire it in `graph`, like any other route:

```ts
graph: {
  nodes: [
    {id: "morning-brief", program: "morning-brief", on: []},
    {id: "notify", program: "notify", on: [{from: "morning-brief", port: "brief", to: "message"}]},
  ],
},
```

The consumer that route is written for is
[`@kampus/tuval-notify`](../tuval-notify),
whose `message` in-port is the other half of it. Cron's half is here and done; the route itself
still does not run, because wiring one program's out-port to another program's in-port across two
config rows is phoenix [#8923](https://github.com/kamp-us/phoenix/issues/8923), open. Until it
lands, `brief` is a declared, tested out-port with nothing on the other end of it.

## Opening a cron as a window

The board tile holds two lines. A run's `summary` — the first line of what the job answered — is
the thing a morning brief actually *is*, so a cron also brings its own window: the schedule, what it
is doing now, and every brief it has come back with, ten deep.

```
daily 07:00
last run 07:00 · ok

[ Run now ]   same as :morning-brief run

07:00  ok      3 PRs merged on phoenix, 1 red on main
06:00  failed  ended without answering
```

`Run now` is the spell without the palette: `WindowHost` offers `dispatch` and no spell call, and
`:<id> run` is itself a bare `send("run", …)`, so the button dispatches the same arrival into the
same cell. It is disabled while a run is up, because a wake mid-run is dropped.

**How the window gets to the browser.** The row carries
`renderer: {kind: "module", ref: "@kampus/tuval-cron/window"}` and the desk's page imports that
specifier itself at boot ([ADR 0359](https://github.com/kamp-us/phoenix/blob/main/.decisions/0359-tuval-window-renderer-is-a-module-specifier.md)).
The other route — an authored `window` field on `defineProgram` — does not work for a package: it
seats the renderer in a map inside the *kernel* process, which the browser tab cannot reach
(phoenix [#8811](https://github.com/kamp-us/phoenix/issues/8811), open). So the module reference is
not a workaround; it is the route phoenix built for exactly this.

**What that asks of your config, and it is not nothing.** The page resolves the specifier from the
config module that declared the row, not from the app (phoenix #8262). So
`@kampus/tuval-cron` has to resolve from beside your `tuval.config.ts` — `pnpm add` it in
`~/.tuval/`, or link it there — and this package has to have been **built**, because `./window`
points at `dist/window.js`. A specifier that resolves from neither there nor the page root
**refuses the page at boot**, naming the specifier and your config:

```
the page server did not start: renderer module "@kampus/tuval-cron/window" does not resolve
from ~/.tuval/tuval.config.ts, the config that declared it; is the package installed
beside that config?
```

The kernel is unaffected either way — the crons still tick and `:morning-brief run` still works —
but the desk has no page until it resolves.

**One upgrade note.** The window reads `id` and `cadence` off state, and a checkpoint written by a
version before this one carries neither. A restore re-seeds both from your config, so a desk that
has booted once is already right; the config is the authority on those two fields and a checkpoint
never is, which is also why moving a cron's `schedule` now reaches the tile on the next boot instead
of being pinned by the old checkpoint.

## How it relates to Tuval

This is a Tuval **program**, built on `defineProgram` out of `@kampus/tuval/authoring`. Everything
around the program is the kernel's: the board tile is what the kernel renders from the `title` and
`status` lines this program publishes; checkpoint and restore are the kernel's, and this program's
only part in them is the `resume` that writes a run a restart cut in half down as failed; the
`:cron run` spell is a `commands` entry the kernel compiles and registers under the program id, so
it is addressable from the command line, a key binding, or an agent, with nothing hand-written on
the caller's side.

It names no session. The job arrives as a shaped arg — typed by its ports alone — so this package
imports no agent implementation, and which program fills it is your config's call.

## Install, and the honest dependency

```bash
pnpm add @kampus/tuval-cron
```

The one runtime dependency is [`cron-parser`](https://github.com/harrisiirak/cron-parser), which is
what reads a `schedule`. Everything else here is a peer.

`@kampus/tuval` is **private and not published to npm**. This package now lives in the same
workspace as Tuval does, so the dependency is a plain workspace one —
`"@kampus/tuval": "workspace:*"` — and pnpm resolves it to `apps/tuval` in this repo with no path
link and no second checkout anywhere. It becomes a real version range the day Tuval ships to a
registry; nothing in the source changes with it, because the source already imports only through
the published doors (#8943, #9250):

- `@kampus/tuval/authoring` — `defineProgram`, `programArgs`, `port`, `Program.shape`, the effect
  constructors (`send`/`spawn`/`stop`/`emit`), `testProgram`, `ProcessId`, `TITLE_PORT`/
  `STATUS_PORT`, and the types around them (`ArgRefs`, `Spawnable`, `PortSchema`)
- `@kampus/tuval/window` — `windowRenderer` and `WindowHost`, the browser-safe half, whose own
  import closure reaches no `node:` builtin. `src/window.tsx` is the only file that touches it, and
  `src/state.ts` is the kernel-free leaf both halves share so a browser never has a path to
  `src/cron.ts`
- `@kampus/tuval/ai-agent/ports` — `PromptPayloadSchema`, `TurnResultSchema`: the agent
  *interface*, which pulls in no agent
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
rather than the load-bearing fix it was when Tuval was reached by path at an outside
checkout — two instances meant a `Schema` built by one was a stranger to a decoder from the other,
and `:cron run`'s args decoded to `Symbol()` instead of `{}`. It stays because the day this package
is consumed from npm beside an unhoisted Tuval, that failure comes back, and it costs nothing now.

## Trust model — read this

Tuval runs local program code with **full trust and no sandbox, ever**. Installing this package is
exactly as consequential as installing a Neovim plugin: it runs with your user's authority. This
program reaches no network and holds no credential of its own — but it *starts an AI-agent session
on a timer*, and that session does whatever your prompt asks with whatever access it has. A cron
whose job is a Claude session with a repo checkout is a Claude session running unattended. Read the
prompt you wrote as if it were a cron entry, because it is one.

## Testing

```bash
pnpm test
pnpm typecheck
```

Seventy-six cases over `testProgram`, the pure state→view mapping and a stated clock — no kernel, no desk, no real timer, no
tokens. Three from the original
in-tree suite are not here, and each is a name the public door does not carry rather than a case
that stopped mattering; `cron.unit.test.ts`'s header says which and why.
