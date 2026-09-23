# @kampus/tuval-shell

A **job** for [Tuval](https://github.com/kamp-us/phoenix/tree/main/apps/tuval): it takes a prompt
and runs it as a shell command, then answers with the output, the exit code and how long it took.

It fits [`@kampus/tuval-cron`](../tuval-cron)'s `jobShape` exactly — `prompt` in, `result` out,
both over the payloads `@kampus/tuval-sdk/ai-agent/ports` publishes — and it is not an AI and has never
heard of one. That is the whole point of the package: cron was written against the AI-agent *port
pair*, which is an interface and not a claim about what is behind it, so a scheduler built for
Claude sessions schedules `git fetch` with no line of either package changed.

## Usage

The pairing, which is what you are almost certainly here for — a nightly fetch:

```ts
// ~/.tuval/tuval.config.ts
import {cron} from "@kampus/tuval-cron";
import {shell} from "@kampus/tuval-shell";
import type {TuvalConfigInput} from "@kampus-apps/tuval/sessions";

export const nightlyFetch = cron({
  id: "nightly-fetch",
  schedule: "0 3 * * *",
  prompt: "git -C ~/phoenix fetch --all",
  job: shell({cwd: "/tmp", timeoutMs: 2 * 60 * 1000}),
});

export default {
  version: 1,
  programs: [nightlyFetch],
  graph: {nodes: [{id: "nightly-fetch", program: "nightly-fetch", on: []}]},
} satisfies TuvalConfigInput;
```

The cron's `prompt` is the command. At 03:00 the cron wakes, spawns the shell, sends it that line,
and the shell's `result` is what the cron's tile reports — `last run 03:00 · ok` against
`exit 0 in 0.4s` on the shell's own tile.

| Field | What it is |
|---|---|
| `id` | What this shell is called: its program id and its graph node id. Defaults to `"shell"` — name it when a config holds more than one. |
| `cwd` | Where every command runs. Not created and not checked: a `cwd` that is not there is a failed run with the reason as its output. |
| `shell` | The interpreter, invoked as `<shell> -c <command>`. Defaults to `/bin/zsh`. |
| `timeoutMs` | Kill the command's process group after this long. Absent waits as long as the command takes. `0` or a negative is refused at `shell(...)`. |
| `env` | Extra environment, *over* the ambient one — a child with no `PATH` can run almost nothing. |

The prompt is run **through the shell**, so `a | b && c > d` means what it says. That is deliberate:
a prompt is a line of text, and a line of text that has to be an argv is not a command.

## What it does, precisely

**One command at a time.** A prompt arriving while one is running is answered with a failed turn
saying what is running — refused, not dropped. The caller is waiting on `result`; a prompt swallowed
in silence is a caller hung for ever.

Read *immediately* out of that for now, because today it is not: Tuval's actor awaits an authored
handler inline under its single-permit semaphore, so a prompt that lands mid-run waits in the inbox
behind the run it would have been refused for, and the refusal reaches the caller only once that
command is over. It is queued rather than dropped and the caller still gets its `result` — what it
does not get is a quick one. The fix is the kernel's, and it is filed as
[kamp-us/phoenix#9297](https://github.com/kamp-us/phoenix/issues/9297); no cell in this package
changes with it.

**Nothing runs on init and nothing runs on a timer.** A command is started by a `PromptPayload`
landing on `prompt` and by nothing else. This is structural rather than a rule somebody remembered:
the only thing that asks for a run is the `prompt` cell, and `init` asks for nothing. Scheduling is
cron's job, and this package does not have a second opinion about it.

**The command runs in an effect handler, not in a Sub.** *Subs observe, handlers perform* — the
`prompt` cell answers this package's own effect, `run({…})`, and Tuval's actor dispatches it to the
handler the row carries. It used to be a Demlik `DepKeyedSub` keyed on `state.running`, which made
the child a function of state: the mechanism a *subscription* is, doing the one thing a command is.
A run happens once because a cell decided it should, which is what a Cmd is for. See
[Swapping the runner](#swapping-the-runner) for the seam that falls out of it.

**A run always reports, even one that could not start.** `spawn` throws *synchronously* on a
command holding a NUL byte — before there is any child to emit an error — and a handler that let
that escape would leave `state.running` set for the life of the process: `running …` on the tile for
ever, every later prompt refused as busy, and the caller hung. So the handler answers a `finished`
with no exit code whatever happens, which reads as `killed`, the same as the async spawn failure
already did.

**A timeout kills the process group, not just the shell.** `sleep 30 | cat` is two processes;
killing the shell alone leaves `cat` holding the pipe, so the "timeout" would hang for as long as
the pipeline did. The child is spawned `detached`, so the kill addresses the whole group.

**A restart does not re-run the command.** `resume` writes a command a restart cut in half down as
`interrupted by restart` and clears the request. A restored process starts on its checkpoint with no
effects, so nothing re-asks for the run: `rm -rf build && make install` is not something to replay
because a desk was restarted.

**Output is bounded at 64 KB, and it is the tail that is kept** — a build that failed says so on its
last line. What was cut is said out loud (`[… 130712 bytes of earlier output dropped]`) rather than
silently, because an output that lies about being whole is worse than one that is short. stdout and
stderr are interleaved in arrival order, as a terminal would show them.

### What the turn carries

`TurnResult` has three fields and each is answered honestly:

- **`text`** — the output, bounded as above.
- **`ok`** — exactly one ending is a success: the command exited, on its own, with `0`. A timeout, a
  signal, a spawn that never happened and a restart are all `false`.
- **`items`** — one `TranscriptItem`, not an empty array. The union has a `tool` member — *a named
  thing ran with this input and produced this result* — which is exactly what happened, so the item
  carries `name: <the shell's id>`, `input: {command, cwd}` and the output through the port's own
  `boundToolResult` (an 8 KB bound that belongs to the port, not to this package). The refusal a
  busy shell answers with is a `system` item instead, which is the union's member for one notice.

The tile reads `shell · phoenix` over `idle`, `running git fetch --all`, `exit 0 in 1.2s`,
`timed out after 120.0s`, `killed after 0.3s` or `interrupted by restart`.

## Swapping the runner

What actually spawns is a service, `ShellRunner`, and `shell(...)` takes it as a second argument —
a built `Context`, not a `Layer`:

```ts
import {shell, ShellRunner} from "@kampus/tuval-shell";
import {Effect} from "effect";

const nothing = ShellRunner.context({
  start: (command) =>
    Effect.succeed({type: "finished", key: command.key, code: 0, output: "", timedOut: false, durationMs: 0}),
});

shell({cwd: "/tmp"}, nothing); // the whole program, with no child process in it
```

It defaults to the real one (`ShellRunnerLive`), and a *config* never passes it — this is the seam,
not a setting. It exists because the handler is ordinary code: the matching of a request to its
ending, the one event it answers with, what a run that cannot start reports, and what happens when
one is interrupted are all testable without spending a process id.

**A `Context` rather than a `Layer`, and the difference is not cosmetic.** The handler runs once per
command, so a `Layer` handed to it is a `Layer` *built* once per command: a `Layer.scoped` runner —
a pool, a connection, a remote executor — would be acquired and released around every single run. A
`Context` is already built, so the mistake is unwritable. A runner that needs acquisition is built
once by its owner (`Layer.build`, under that owner's Scope) and handed over as the `Context` that
comes out.

Interruption is the handler's too — `startCommand`'s abandon is the Effect's finalizer, so an
interrupted run kills the process group rather than leaving it up. How much that covers is the
actor's call and not this package's: the finalizer runs when the Scope the handler was forked into
closes, and the path Tuval's actor currently takes waits on the child instead, which is the other
half of [kamp-us/phoenix#9297](https://github.com/kamp-us/phoenix/issues/9297).

## How it relates to Tuval

This is a Tuval **program**, built on `defineProgram` out of `@kampus/tuval-sdk/authoring`. Everything
around the program is the kernel's: the board tile is what the kernel renders from the `title` and
`status` lines this program publishes, and checkpoint and restore are the kernel's, with this
program's only part in them the `resume` above.

It declares no args and fills none — a shell job is handed its command by the prompt, so there is
nothing for a config to wire into it beyond where it runs. It has no window and no spell; running a
command on demand is `:<cron id> run` on the cron in front of it.

It names one effect of its own, which is #8716 R12.1 and reachable from an authored `update` as of
[#9295](https://github.com/kamp-us/phoenix/pull/9295). Two halves, both written here: `Run` is
`defineProgram`'s last type argument, and the handler goes onto the compiled row by spread
(`{...row, handlers: {...row.handlers, "shell/run": runHandler(runner)}}`). The kernel runs it and
feeds its answer back into this program's inbox as an ordinary `finished` event.

## Install, and the honest dependency

```bash
pnpm add @kampus/tuval-shell
```

There are **no runtime dependencies** — `node:child_process` is the whole of the machinery, and
`effect` (which the handler is written in) is a peer, shared with Tuval itself. Everything else here
is a peer too.

**`@demlik/tea` is vestigial.** The Sub was its last importer and the Sub is gone, so no file in
`src/` reaches Demlik any more. The peer entry stays for now — dropping a peer dependency is a
published-API change and belongs in its own release, not in a refactor — but nothing in this package
resolves it, and its `resolve.dedupe` entry has already been removed.

`@kampus/tuval-sdk` is **publishable but not yet on npm**. This package now lives in the same
workspace as Tuval does, so the dependency is a plain workspace one —
`"@kampus/tuval-sdk": "workspace:*"` — and pnpm resolves it to `packages/tuval` in this repo with no path
link and no second checkout anywhere. It becomes a real version range the day Tuval ships to a
registry; nothing in the source changes with it, because the source already imports only through
the published doors (#8943, #9250):

- `@kampus/tuval-sdk/authoring` — `defineProgram`, `port`, `emit`, `testProgram`, and the types around
  them (`Answer`, `ArrivalEvent`, `AuthoredEvent`, `AnyProgram`, `AuthoredProgram`)
- `@kampus/tuval-sdk/ai-agent/ports` — `PromptPayloadSchema`, `TurnResultSchema`, `ItemId`,
  `boundToolResult`: the agent *interface*, which pulls in no agent

Nothing reaches `@kampus/tuval-sdk/src/...`; the exports map would refuse it anyway.

## Settings this package borrows from Tuval

Two settings here are not this package's taste. They are restatements of `apps/tuval`'s, and they
exist because `@kampus/tuval-sdk` is consumed as **raw TypeScript source**: its `exports` map points at
`src/*.ts` and it ships no `.d.ts`. Both go away the day Tuval publishes built declarations.

**`tsconfig.json`: `lib: ["ES2023", "DOM", "DOM.Iterable"]` and `exactOptionalPropertyTypes: false`.**
Tuval's whole reachable source tree enters this program and is checked under *these* options —
`skipLibCheck` covers declaration files and does nothing for source. These two lines are
`apps/tuval/tsconfig.json`'s, restated, and a consumer that picked its own would be told about
`findLast`, `Element` and the MCP SDK's optional props in code it does not own.

**`vitest.config.ts`: `resolve.dedupe: ["effect"]`.** One workspace and one root `catalog:` pin
already give the suite a single `effect`, so this line is belt and braces here rather than the
load-bearing fix it was when Tuval was reached by path at an outside checkout — two instances meant
a `Schema` built by one was a stranger to a decoder from the other. It stays because the day this
package is consumed from npm beside an unhoisted Tuval, that failure comes back, and it costs
nothing now.

## Trust model — read this

Tuval runs local program code with **full trust and no sandbox, ever**. This package is the sharpest
edge of that: it is a program whose entire job is to run whatever line of text arrives on a port, as
your user, with your environment and your credentials. A cron whose prompt is a command is a crontab
entry with fewer people looking at it, and anything that can reach this program's `prompt` port can
run anything you can. Read the command you wrote as if it were a crontab line, because it is one.

## Testing

```bash
pnpm test
pnpm typecheck
```

Sixty-nine cases: the leaf's two tile lines and the output bound as pure functions, the program over
`testProgram` with a `finished` event fed in by hand, the runner against real child processes
(a timeout, a killed pipeline, a 128 KB output, a `cwd` that is not there), the handler seam in both
directions — the effect the cell asked for handed to a fake runner and its events fed back through
`update`, the same loop again with a real child and no fake anywhere, and a run that dies before it
can report (a runner that throws, and a real `spawn` refusing a NUL byte) coming out as a failed
turn with the request cleared — and
`compose.unit.test.ts`, which is the package's own claim: `cron({…, job: shell({…})})` returns, and
a call that returns is the fit.
